import express from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import dotenv from 'dotenv';
import cors from 'cors';
import { exec } from 'child_process';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(cors());

app.use('/clips', express.static('clips'));

const ensureDirectoriesExist = () => {
  if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
    console.log("Created 'uploads' directory.");
  }
  if (!fs.existsSync('clips')) {
    fs.mkdirSync('clips');
    console.log("Created 'clips' directory.");
  }
};
ensureDirectoriesExist();

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 200 * 1024 * 1024 }
});


app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  console.log('Received file for upload:', req.file.originalname);

  const videoFilePath = req.file.path;
  const audioOutputPath = `${req.file.path}.mp3`;

  try {
    console.log(`Extracting audio from: ${videoFilePath}`);
    await new Promise((resolve, reject) => {
      const ffmpegCommand = `ffmpeg -i "${videoFilePath}" -vn -acodec libmp3lame -q:a 2 "${audioOutputPath}"`;

      exec(ffmpegCommand, (error, stdout, stderr) => {
        if (error) {
          console.error('FFmpeg audio extraction error:', error.message);
          console.error('FFmpeg stdout:', stdout);
          console.error('FFmpeg stderr:', stderr);
          return reject(new Error(`FFmpeg failed to extract audio: ${error.message}`));
        }
        console.log('Audio extraction complete:', audioOutputPath);
        resolve();
      });
    });

    console.log('Sending audio to Whisper...');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioOutputPath));
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularity', 'segment');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
        timeout: 10 * 60 * 1000 // 10 minutes timeout for Whisper transcription
      }
    );

    console.log('Whisper transcription complete.');
    res.json({
        fullTranscriptionData: response.data,
        uploadedFilePath: videoFilePath
    });

  } catch (error) {
    console.error('Error during /upload endpoint (Whisper):', error.response?.data || error.message);
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      res.status(504).json({ error: 'Transcription timed out. Please try a shorter video or check your internet connection.' });
    } else {
      res.status(500).json({ error: 'Failed to process video for transcription.' });
    }
  } finally {
    try {
      if (fs.existsSync(audioOutputPath)) {
        fs.unlinkSync(audioOutputPath);
        console.log('Cleaned up extracted audio file:', audioOutputPath);
      }
    } catch (cleanupError) {
      console.error('Cleanup error for audio file:', cleanupError.message);
    }
  }
});


app.post('/cut-clip', async (req, res) => {
  const { originalVideoTempPath, clipTitle, startTimeSeconds, endTimeSeconds } = req.body;

  if (!originalVideoTempPath || startTimeSeconds === undefined || endTimeSeconds === undefined || !clipTitle) {
    return res.status(400).json({ error: 'Missing clip cutting parameters.' });
  }

  if (!fs.existsSync(originalVideoTempPath)) {
    console.error(`Original video file not found at: ${originalVideoTempPath}`);
    return res.status(404).json({ error: 'Original video file not found on server. Please re-upload the video.' });
  }

  const sanitizedTitle = clipTitle.replace(/[^a-zA-Z0-9.\-_]/g, '-').replace(/-+/g, '-').toLowerCase();
  const outputFileName = `${sanitizedTitle}_clip_${Date.now()}.mp4`;
  const outputFilePath = `clips/${outputFileName}`;

  try {
    console.log(`Starting FFmpeg to cut clip: "${clipTitle}" from ${originalVideoTempPath} (Start: ${startTimeSeconds}s, End: ${endTimeSeconds}s)`);
    await new Promise((resolve, reject) => {
      const ffmpegCommand = `ffmpeg -i "${originalVideoTempPath}" -ss ${startTimeSeconds} -to ${endTimeSeconds} -c copy "${outputFilePath}"`;

      exec(ffmpegCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`FFmpeg cutting error for ${outputFileName}:`, error.message);
          console.error(`FFmpeg stdout:`, stdout);
          console.error(`FFmpeg stderr:`, stderr);
          return reject(new Error(`Failed to cut video clip: ${error.message}`));
        }
        console.log(`Video clip "${outputFileName}" cut successfully.`);
        resolve();
      });
    });

    const clipDownloadUrl = `http://localhost:${PORT}/clips/${outputFileName}`;
    res.json({ message: 'Clip cut successfully', downloadUrl: clipDownloadUrl });

  } catch (error) {
    console.error('Error during /cut-clip endpoint:', error.message);
    res.status(500).json({ error: 'Failed to cut video clip due to an internal server error.' });
  }
});


// Helper function to chunk transcription segments for GPT processing
const chunkSegments = (segments, chunkSizeSeconds = 180, overlapSeconds = 10) => {
    const chunks = [];
    if (!segments || segments.length === 0) return chunks;

    let currentSegmentIndex = 0;
    while (currentSegmentIndex < segments.length) {
        const chunkStartTime = segments[currentSegmentIndex].start;
        let chunkEndTime = chunkStartTime + chunkSizeSeconds;
        let endSegmentIndex = currentSegmentIndex;

        while (endSegmentIndex < segments.length && segments[endSegmentIndex].end < chunkEndTime) {
            endSegmentIndex++;
        }
        if (endSegmentIndex >= segments.length) {
            endSegmentIndex = segments.length - 1;
            if(currentSegmentIndex > endSegmentIndex && chunks.length > 0) break;
        }

        if (segments[endSegmentIndex]) {
            chunkEndTime = segments[endSegmentIndex].end;
        } else if (segments[segments.length - 1]) {
            chunkEndTime = segments[segments.length - 1].end;
        }

        const currentChunkSegments = segments.slice(currentSegmentIndex, endSegmentIndex + 1);
        const chunkText = currentChunkSegments.map(s => s.text).join(' ');

        if (chunkText.trim()) {
            chunks.push({
                text: chunkText,
                segments: currentChunkSegments,
                startTime: currentChunkSegments[0].start,
                endTime: currentChunkSegments[currentChunkSegments.length - 1].end
            });
        }
        
        let nextSegmentStart = chunkEndTime - overlapSeconds;
        let foundNextIndex = segments.findIndex(s => s.start >= nextSegmentStart);
        if (foundNextIndex === -1 || foundNextIndex <= currentSegmentIndex) {
            currentSegmentIndex = endSegmentIndex + 1;
        } else {
            currentSegmentIndex = foundNextIndex;
        }
    }

    return chunks;
};


// POST endpoint to detect best clips using OpenAI GPT and perform batch cutting
app.post('/detect-clips', async (req, res) => {
  const { fullTranscriptionData, originalVideoTempPath, clipOption, desiredClipCount, desiredClipDuration } = req.body;

  const segments = fullTranscriptionData?.segments || [];
  const fullText = fullTranscriptionData?.text;

  const totalVideoDuration = segments.length > 0 ? segments[segments.length - 1].end : 0;
  console.log(`Total video duration derived from segments: ${totalVideoDuration.toFixed(2)}s`);


  if (!fullText) {
    console.log('No transcript text provided.');
    return res.status(400).json({ error: 'No transcript available for clip detection.' });
  }
  if (!originalVideoTempPath || !fs.existsSync(originalVideoTempPath)) {
    console.log(`Original video file not found for cutting at: ${originalVideoTempPath}`);
    return res.status(404).json({ error: 'Original video file not found on server. Cannot cut clips.' });
  }

  try {
    let targetMinDuration = 10;
    let targetMaxDuration = 60;

    if (desiredClipDuration && typeof desiredClipDuration === 'number') {
        targetMinDuration = Math.max(5, desiredClipDuration - 5);
        targetMaxDuration = desiredClipDuration + 15;
        targetMaxDuration = Math.min(targetMaxDuration, 120);
    }

    console.log(`Processing video for clip detection: Total segments: ${segments.length}, Full text length: ${fullText.length}`);
    const transcriptChunks = chunkSegments(segments, 180, 20); // 3-min chunks, 20s overlap
    console.log(`Divided transcript into ${transcriptChunks.length} chunks.`);

    let allDetectedClipsFromChunks = [];

    for (const [index, chunk] of transcriptChunks.entries()) {
        console.log(`Sending chunk ${index + 1}/${transcriptChunks.length} (from ${chunk.startTime.toFixed(2)}s to ${chunk.endTime.toFixed(2)}s) to GPT.`);
        const chunkPrompt = `
        You are an AI assistant specialized in identifying key moments from video transcripts.
        Analyze the following transcript chunk and identify 1-2 highly impactful and distinct short video clips.
        Each clip MUST be between ${targetMinDuration} and ${targetMaxDuration} seconds in length.
        Prioritize content that is compelling and can stand alone well within this chunk.
        If a suitable clip extends beyond this chunk's text, indicate its full range using the provided segments' timestamps.
        
        **IMPORTANT JSON FORMATTING RULES:**
        - The response MUST be a JSON array of objects.
        - Each object in the array MUST have the keys: "title", "description", "startTimeSeconds", "endTimeSeconds", "reason".
        - Ensure all string values are properly escaped for JSON (e.g., double quotes within strings become \\").
        - Ensure startTimeSeconds and endTimeSeconds are accurate based on the provided segments, and endTimeSeconds is always greater than startTimeSeconds.
        - If you find no suitable clips in this chunk based on the requested criteria, return an empty JSON array: [].
        - DO NOT include any text, markdown code blocks, or explanations outside of the JSON array. Your response should start directly with the JSON array.

        Transcript Chunk (from ${chunk.startTime.toFixed(2)}s to ${chunk.endTime.toFixed(2)}s):
        ${chunk.text}

        Segments for this chunk (use these for precise timing):
        ${chunk.segments.map(s => `[${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s] ${s.text}`).join('\n')}
        `;

        const chunkPayload = {
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: 'You are an AI video clipper assistant. Your output MUST be a JSON array of clip objects. Only return the JSON array.' },
                { role: 'user', content: chunkPrompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.7,
            max_tokens: 1000
        };

        try {
            const gptChunkResponse = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                chunkPayload,
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 1 * 60 * 1000
                }
            );
            const rawChunkOutput = gptChunkResponse.data.choices[0].message.content;
            console.log(`Raw GPT Output for chunk ${index + 1}:`, rawChunkOutput);

            let jsonString = rawChunkOutput;
            if (rawChunkOutput === null || rawChunkOutput === undefined || rawChunkOutput.trim() === '') {
                console.warn(`Raw GPT Output for chunk ${index + 1} was null, undefined or empty. Treating as empty array.`);
                jsonString = "[]";
            } else {
                const jsonRegex = /\[\s*\{[\s\S]*\}\s*\]/;
                const match = rawChunkOutput.match(jsonRegex);
                if (match && match[0]) {
                    jsonString = match[0];
                    console.log("Extracted JSON string using regex for chunk.");
                } else {
                    console.warn("Regex failed to extract JSON array for chunk. Attempting to parse raw output directly.");
                }
            }
            
            let parsedChunkClips = [];
            try {
                parsedChunkClips = JSON.parse(jsonString);
            } catch (parseErr) {
                console.error(`JSON parse error for chunk ${index + 1}:`, parseErr.message, `\nProblematic string:`, jsonString);
            }

            if (!Array.isArray(parsedChunkClips)) {
                if (typeof parsedChunkClips === 'object' && parsedChunkClips !== null && parsedChunkClips.title) {
                    parsedChunkClips = [parsedChunkClips];
                    console.log(`Chunk ${index+1}: GPT returned a single valid clip object, wrapping it in an array.`);
                } else {
                    parsedChunkClips = [];
                }
            }

            parsedChunkClips = parsedChunkClips.filter(clip =>
                typeof clip === 'object' && clip !== null &&
                typeof clip.title === 'string' &&
                typeof clip.description === 'string' &&
                typeof clip.startTimeSeconds === 'number' &&
                typeof clip.endTimeSeconds === 'number' &&
                typeof clip.reason === 'string' &&
                clip.startTimeSeconds < clip.endTimeSeconds &&
                // Original filtering for min/max duration (this applies to clips from chunks)
                (clip.endTimeSeconds - clip.startTimeSeconds) >= targetMinDuration &&
                (clip.endTimeSeconds - clip.startTimeSeconds) <= targetMaxDuration &&
                // Ensure times are within the chunk bounds (optional, but good for sanity)
                clip.startTimeSeconds >= chunk.startTime && clip.endTimeSeconds <= chunk.endTime
            );
            allDetectedClipsFromChunks.push(...parsedChunkClips);

        } catch (chunkError) {
            console.error(`Error processing chunk ${index + 1} with GPT (outer try-catch):`, chunkError.response?.data || chunkError.message);
        }
    }

    let finalSelectedClips = [];

    const uniqueClips = [];
    const seenStartTimes = new Set();
    const overlapThreshold = 5;

    for (const clip of allDetectedClipsFromChunks) {
        let isDuplicate = false;
        for (const existingUniqueClip of uniqueClips) {
            if (Math.abs(clip.startTimeSeconds - existingUniqueClip.startTimeSeconds) < overlapThreshold ||
                (clip.startTimeSeconds >= existingUniqueClip.startTimeSeconds && clip.endTimeSeconds <= existingUniqueClip.endTimeSeconds + overlapThreshold)) {
                isDuplicate = true;
                break;
            }
        }
        if (!isDuplicate) {
            uniqueClips.push(clip);
        } else {
            console.log(`Skipping potential duplicate clip: "${clip.title}" starting at ${clip.startTimeSeconds.toFixed(2)}s`);
        }
    }
    console.log(`Found ${uniqueClips.length} truly unique clips after chunk processing.`);

    uniqueClips.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    let userDesiredCount = 0;
    if (clipOption === 'userChoice') {
        userDesiredCount = desiredClipCount === 'max' ? uniqueClips.length : parseInt(desiredClipCount);
    } else { // aiPick
        userDesiredCount = Math.min(uniqueClips.length, 3);
    }


    finalSelectedClips = [];
    let currentCandidates = [...uniqueClips]; 

    // Apply duration filter again before selection (important for user choice)
    currentCandidates = currentCandidates.filter(clip =>
        (clip.endTimeSeconds - clip.startTimeSeconds) >= targetMinDuration &&
        (clip.endTimeSeconds - clip.startTimeSeconds) <= targetMaxDuration
    );
    console.log(`After final duration filtering, ${currentCandidates.length} clips remain.`);


    if (userDesiredCount > 0 && currentCandidates.length >= userDesiredCount) {
        finalSelectedClips = currentCandidates.slice(0, userDesiredCount);
        console.log(`Exactly ${finalSelectedClips.length} clips selected to match user desired count.`);
    } else if (userDesiredCount > 0 && currentCandidates.length < userDesiredCount && currentCandidates.length > 0) {
        console.log(`Not enough unique candidates (${currentCandidates.length}) for user's desired count (${userDesiredCount}). Attempting to create more clips by splitting/padding.`);
        
        let tempClips = [...currentCandidates];
        // --- NEW LOGIC START: More robust splitting and padding ---
        // Fill up to desired count by splitting longest valid clips
        let currentSplitAttempts = 0;
        const maxTotalSplitAttempts = userDesiredCount * 3; // Prevent infinite loops

        // First pass: try to split existing longer clips
        while (tempClips.length < userDesiredCount && currentSplitAttempts < maxTotalSplitAttempts) {
            const splittableClips = tempClips.filter(c => 
                (c.endTimeSeconds - c.startTimeSeconds) >= (targetMinDuration * 1.5) // Clip needs to be at least 1.5x target min to split meaningfully
            ).sort((a, b) => (b.endTimeSeconds - b.startTimeSeconds) - (a.endTimeSeconds - a.startTimeSeconds)); // Longest first

            if (splittableClips.length === 0) {
                console.log("No more splittable clips found in first pass.");
                break;
            }

            const clipToSplit = splittableClips[0];
            const originalIndex = tempClips.indexOf(clipToSplit);
            
            const splitDuration = (clipToSplit.endTimeSeconds - clipToSplit.startTimeSeconds) / 2;
            const midpoint = clipToSplit.startTimeSeconds + splitDuration;
            
            const firstHalf = {
                ...clipToSplit,
                title: `${clipToSplit.title} (Part A)`,
                endTimeSeconds: midpoint,
                reason: `${clipToSplit.reason} (Split to meet count)`
            };
            const secondHalf = {
                ...clipToSplit,
                title: `${clipToSplit.title} (Part B)`,
                startTimeSeconds: midpoint,
                reason: `${clipToSplit.reason} (Split to meet count)`
            };

            const newHalves = [];
            // Ensure split halves are at least half the target min duration to be useful
            if ((firstHalf.endTimeSeconds - firstHalf.startTimeSeconds) >= targetMinDuration / 2) newHalves.push(firstHalf);
            if ((secondHalf.endTimeSeconds - secondHalf.startTimeSeconds) >= targetMinDuration / 2) newHalves.push(secondHalf);

            if (newHalves.length > 0) {
                tempClips.splice(originalIndex, 1, ...newHalves);
                tempClips.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds); // Re-sort
                console.log(`Split clip "${clipToSplit.title}" into two. Current tempClips count: ${tempClips.length}`);
            } else {
                tempClips.splice(originalIndex, 1); // Remove if couldn't split meaningfully
                console.log(`Attempted to split "${clipToSplit.title}" but halves too short. Removed original.`);
            }
            currentSplitAttempts++;
        }
        
        // Second pass: If still not enough, create simple sequential clips from remaining transcript
        // This is a fallback to guarantee count, even if not "AI-picked" highlights
        if (tempClips.length < userDesiredCount && totalVideoDuration > 0) {
            console.log(`Still need more clips. Current: ${tempClips.length}, Desired: ${userDesiredCount}. Creating sequential filler clips.`);
            let lastEndTime = 0;
            if (tempClips.length > 0) {
                lastEndTime = tempClips[tempClips.length - 1].endTimeSeconds;
            } else if (segments.length > 0) { // If no clips generated at all, start from beginning
                lastEndTime = segments[0].start;
            }

            while (tempClips.length < userDesiredCount && lastEndTime < totalVideoDuration) {
                let newClipStartTime = lastEndTime;
                let newClipEndTime = Math.min(newClipStartTime + desiredClipDuration, totalVideoDuration);

                // Find the nearest segment boundary for cleaner cuts
                if (segments.length > 0) {
                    const segmentStart = segments.find(s => s.start >= newClipStartTime && s.start < newClipEndTime);
                    if (segmentStart) newClipStartTime = segmentStart.start;

                    const segmentEnd = segments.find(s => s.end >= newClipEndTime);
                    if (segmentEnd) newClipEndTime = segmentEnd.end;
                    else newClipEndTime = totalVideoDuration; // If no end segment found, go to end of video
                }
                
                // Ensure duration is reasonable, if not, break
                if (newClipEndTime - newClipStartTime < targetMinDuration / 2) { // Minimum 5s for filler
                    console.log("Remaining duration too short for meaningful filler clip. Breaking.");
                    break;
                }

                tempClips.push({
                    title: `Auto-Generated Clip ${tempClips.length + 1}`,
                    description: `Automatically generated segment from video.`,
                    startTimeSeconds: newClipStartTime,
                    endTimeSeconds: newClipEndTime,
                    reason: "Automatically generated to meet user's clip count request."
                });
                lastEndTime = newClipEndTime;
                console.log(`Created filler clip. New tempClips count: ${tempClips.length}`);

                // Prevent infinite loop in very short/problematic videos
                if (lastEndTime >= totalVideoDuration && tempClips.length < userDesiredCount) {
                    console.log("Reached end of video, cannot generate more filler clips.");
                    break;
                }
            }
        }
        finalSelectedClips = tempClips.slice(0, userDesiredCount); // Final slice to desired count
        console.log(`Final selected clips after all splitting/padding attempts: ${finalSelectedClips.length}`);

    } else if (userDesiredCount > 0 && currentCandidates.length === 0) {
        // If user desires clips but none found even after chunking/GPT, and no auto-generation can occur
        console.warn(`User desired ${userDesiredCount} clips, but no candidates found from any chunk. Cannot generate filler clips.`);
        finalSelectedClips = []; // Explicitly ensure empty array
    } else {
        // If userDesiredCount is 0 or no specific number requested, take all unique
        finalSelectedClips = currentCandidates;
    }

    // Final validity filter before sending to frontend/cutting
    finalSelectedClips = finalSelectedClips.filter(clip =>
        typeof clip === 'object' && clip !== null &&
        typeof clip.title === 'string' &&
        typeof clip.description === 'string' &&
        typeof clip.startTimeSeconds === 'number' &&
        typeof clip.endTimeSeconds === 'number' &&
        typeof clip.reason === 'string' &&
        clip.startTimeSeconds >= 0 &&
        clip.endTimeSeconds <= totalVideoDuration &&
        clip.startTimeSeconds < clip.endTimeSeconds &&
        (clip.endTimeSeconds - clip.startTimeSeconds) >= 2 // Minimum 2 seconds final clip duration
    );

    if (finalSelectedClips.length === 0 && userDesiredCount > 0) {
      console.warn("Despite all efforts, no valid clips could be generated or parsed to meet user request.");
    }


    const clipsWithDownloadUrls = [];
    for (const clip of finalSelectedClips) {
        const sanitizedTitle = clip.title.replace(/[^a-zA-Z0-9.\-_]/g, '-').replace(/-+/g, '-').toLowerCase();
        const outputFileName = `${sanitizedTitle}_clip_${Date.now()}.mp4`;
        const outputFilePath = `clips/${outputFileName}`;

        try {
            console.log(`[Batch Cutting] Cutting clip: "${clip.title}" (Start: ${clip.startTimeSeconds}s, End: ${clip.endTimeSeconds}s)`);
            await new Promise((resolve, reject) => {
                const ffmpegCommand = `ffmpeg -i "${originalVideoTempPath}" -ss ${clip.startTimeSeconds} -to ${clip.endTimeSeconds} -c copy "${outputFilePath}"`;
                exec(ffmpegCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`[Batch Cutting] FFmpeg error for ${outputFileName}:`, error.message);
                        console.error(`[Batch Cutting] FFmpeg stdout:`, stdout);
                        console.error(`[Batch Cutting] FFmpeg stderr:`, stderr);
                        return reject(new Error(`Failed to cut clip ${clip.title}`));
                    }
                    console.log(`[Batch Cutting] Clip "${outputFileName}" cut successfully.`);
                    resolve();
                });
            });
            clipsWithDownloadUrls.push({
                ...clip,
                downloadUrl: `http://localhost:${PORT}/clips/${outputFileName}`
            });
        } catch (clipError) {
            console.error(`[Batch Cutting] Skipping clip "${clip.title}" due to cutting error:`, clipError.message);
        }
    }

    res.json({ clips: clipsWithDownloadUrls });

  } catch (error) {
    console.error('Error detecting and cutting clips (overall pipeline):', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to detect and cut clips due to an internal AI or processing error.' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

server.timeout = 5 * 60 * 1000; // 5 minutes timeout (adjust as needed for very large videos)
console.log(`Server timeout set to ${server.timeout / 1000} seconds.`);