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

// --- IMPORTANT: Increase payload size limits for Express ---
// This allows Express to handle larger JSON and URL-encoded bodies.
// '200mb' is a common safe upper limit for video processing payloads.
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(cors());

// Serve static files from the 'clips' directory
app.use('/clips', express.static('clips'));

// Function to ensure 'uploads' and 'clips' directories exist
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

// --- IMPORTANT: Configure Multer file size limit ---
// Multer also has its own limit. 200MB (200 * 1024 * 1024 bytes) should be sufficient for 51MB.
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 200 * 1024 * 1024 } // 200 MB limit
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

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
        params: {
          response_format: 'verbose_json'
        }
      }
    );

    console.log('Whisper transcription complete.');
    res.json({
        fullTranscriptionData: response.data,
        uploadedFilePath: videoFilePath
    });

  } catch (error) {
    console.error('Error during /upload endpoint:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to process video for transcription.' });
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
        console.log(`Video clip "${outputFileName}" cut successfully and saved to ${outputFilePath}.`);
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


app.post('/detect-clips', async (req, res) => {
  const { fullTranscriptionData, originalVideoTempPath } = req.body;
  const segments = fullTranscriptionData?.segments || [];
  const fullText = fullTranscriptionData?.text;

  if (!fullText) {
    console.log('No transcript text provided.');
    return res.status(400).json({ error: 'No transcript available for clip detection.' });
  }
  if (!originalVideoTempPath || !fs.existsSync(originalVideoTempPath)) {
    console.log(`Original video file not found for cutting at: ${originalVideoTempPath}`);
    return res.status(404).json({ error: 'Original video file not found on server. Cannot cut clips.' });
  }

  try {
    const prompt = `
You are an AI video editor. Identify 1-3 short video clips (ideally 10 to 60 seconds each, but adjust based on natural breaks) from the following transcript.
Provide ONLY a JSON array of objects. **ALWAYS ensure the top-level response is a JSON array, even if it contains only one clip object.** Each object in the array should have the following keys:
- "title": "string",
- "description": "string",
- "startTimeSeconds": float,
- "endTimeSeconds": float,
- "reason": "string"

**IMPORTANT:**
- The response MUST be a JSON array of objects.
- Each object in the array MUST have the keys: "title", "description", "startTimeSeconds", "endTimeSeconds", "reason".
- If you find no suitable clips, return an empty JSON array: [].
- DO NOT include any text, markdown code blocks, or explanations outside of the JSON array. Your response should start directly with the JSON array.

Transcript:
${fullText}

Segments (use these for precise timing if available):
${segments.map(s => `[${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s] ${s.text}`).join('\n')}
    `;

    const openaiPayload = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an AI video clipper assistant. Your output MUST be a JSON array of clip objects. Only return the JSON array. DO NOT include any text before or after the JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 1500
    };

    console.log('Payload sent to OpenAI Chat Completions:', JSON.stringify(openaiPayload, null, 2));


    const gptResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      openaiPayload,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const rawGptOutput = gptResponse.data.choices[0].message.content;
    console.log('Raw GPT Output:', rawGptOutput);

    let detectedClips = [];
    try {
      const parsedOutput = JSON.parse(rawGptOutput);

      if (Array.isArray(parsedOutput)) {
        detectedClips = parsedOutput;
      } else if (typeof parsedOutput === 'object' && parsedOutput !== null) {
        if (Array.isArray(parsedOutput.clips)) {
          detectedClips = parsedOutput.clips;
        } else {
          if (
              typeof parsedOutput.title === 'string' &&
              typeof parsedOutput.description === 'string' &&
              typeof parsedOutput.startTimeSeconds === 'number' &&
              typeof parsedOutput.endTimeSeconds === 'number' &&
              typeof parsedOutput.reason === 'string'
          ) {
              detectedClips = [parsedOutput];
              console.log("GPT returned a single valid clip object, wrapping it in an array.");
          } else {
            console.warn("GPT response was a JSON object but did not conform to expected clip structure. Returning empty array.");
            detectedClips = [];
          }
        }
      } else {
        console.warn("GPT response was neither a JSON array nor a JSON object. Returning empty array.");
        detectedClips = [];
      }

      detectedClips = detectedClips.filter(clip =>
        typeof clip === 'object' && clip !== null &&
        typeof clip.title === 'string' &&
        typeof clip.description === 'string' &&
        typeof clip.startTimeSeconds === 'number' &&
        typeof clip.endTimeSeconds === 'number' &&
        typeof clip.reason === 'string'
      );

      if (detectedClips.length === 0) {
        console.warn("No valid clips were generated or parsed from GPT's response after filtering.");
      }

    } catch (parseError) {
      console.error('Failed to parse GPT response JSON:', parseError);
      return res.status(200).json({ clips: [], warning: 'Failed to parse AI clip suggestions. No clips generated.' });
    }

    const finalClipsForFrontend = [];
    for (const clip of detectedClips) {
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
            finalClipsForFrontend.push({
                ...clip,
                downloadUrl: `http://localhost:${PORT}/clips/${outputFileName}`
            });
        } catch (clipError) {
            console.error(`[Batch Cutting] Skipping clip "${clip.title}" due to cutting error:`, clipError.message);
        }
    }

    res.json({ clips: finalClipsForFrontend });

  } catch (error) {
    console.error('Error detecting and cutting clips:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to detect and cut clips due to an internal AI or processing error.' });
  }
});

// --- IMPORTANT: Set a longer timeout for the server to handle large file processing ---
const server = app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

server.timeout = 5 * 60 * 1000; // 5 minutes timeout (adjust as needed for very large videos)
console.log(`Server timeout set to ${server.timeout / 1000} seconds.`);