import express from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import dotenv from 'dotenv';
import cors from 'cors';
import { exec } from 'child_process'; // For running shell commands like FFmpeg

dotenv.config(); // Load environment variables from .env file

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware to parse JSON bodies for incoming requests
app.use(express.json());
// Enable CORS for all origins (for development). Restrict in production.
app.use(cors());

// Serve static files from the 'clips' directory
// This allows cut video clips to be accessible via HTTP (e.g., http://localhost:5000/clips/your_clip.mp4)
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
ensureDirectoriesExist(); // Call this once when the server starts

// CRITICAL LINE: Define 'upload' here, at the top-level scope
const upload = multer({ dest: 'uploads/' });


// POST endpoint to handle video uploads and initiate transcription
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  console.log('Received file for upload:', req.file.originalname);

  const videoFilePath = req.file.path; // Temporary path where Multer saved the original video
  const audioOutputPath = `${req.file.path}.mp3`; // Path for the extracted audio file

  try {
    console.log(`Extracting audio from: ${videoFilePath}`);
    await new Promise((resolve, reject) => {
      // FFmpeg command to extract audio from video and save as MP3
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
    formData.append('model', 'whisper-1'); // Specify the Whisper model for transcription

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
        params: {
          response_format: 'verbose_json' // Request detailed timestamp information from Whisper
        }
      }
    );

    console.log('Whisper transcription complete.');
    // Return the full transcription data AND the temporary uploaded file path to the frontend
    res.json({
        fullTranscriptionData: response.data,
        uploadedFilePath: videoFilePath // Pass the temporary path for later video cutting
    });

  } catch (error) {
    console.error('Error during /upload endpoint:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to process video for transcription.' });
  } finally {
    // IMPORTANT FOR DEVELOPMENT/TESTING:
    // Only clean up the extracted audio file. The original video needs to persist temporarily
    // in the 'uploads/' folder for the /cut-clip endpoint to access it.
    // In production, handle persistence and cleanup with cloud storage.
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

// POST endpoint to handle actual video cutting using FFmpeg
app.post('/cut-clip', async (req, res) => {
  // Extract parameters from the request body
  const { originalVideoTempPath, clipTitle, startTimeSeconds, endTimeSeconds } = req.body;

  // Basic validation of required parameters
  if (!originalVideoTempPath || startTimeSeconds === undefined || endTimeSeconds === undefined || !clipTitle) {
    return res.status(400).json({ error: 'Missing clip cutting parameters.' });
  }

  // Verify the original video file still exists
  if (!fs.existsSync(originalVideoTempPath)) {
    console.error(`Original video file not found at: ${originalVideoTempPath}`);
    return res.status(404).json({ error: 'Original video file not found on server. Please re-upload the video.' });
  }

  // Sanitize clip title for use in filename to prevent filesystem issues
  const sanitizedTitle = clipTitle.replace(/[^a-zA-Z0-9.\-_]/g, '-').replace(/-+/g, '-').toLowerCase();
  const outputFileName = `${sanitizedTitle}_clip_${Date.now()}.mp4`; // Generate a unique filename
  const outputFilePath = `clips/${outputFileName}`; // Full path for the output clip

  try {
    console.log(`Starting FFmpeg to cut clip: "${clipTitle}" from ${originalVideoTempPath} (Start: ${startTimeSeconds}s, End: ${endTimeSeconds}s)`);
    await new Promise((resolve, reject) => {
      // FFmpeg command for cutting:
      // -i: input file (original video)
      // -ss: start time (in seconds)
      // -to: end time (in seconds)
      // -c: copy: stream copy video and audio (very fast, no re-encoding, but cuts only on keyframes, which might be slightly imprecise)
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

    // Construct the URL where the cut clip can be downloaded from the server
    const clipDownloadUrl = `http://localhost:${PORT}/clips/${outputFileName}`;
    res.json({ message: 'Clip cut successfully', downloadUrl: clipDownloadUrl });

  } catch (error) {
    console.error('Error during /cut-clip endpoint:', error.message);
    res.status(500).json({ error: 'Failed to cut video clip due to an internal server error.' });
  }
});


// POST endpoint to detect best clips using OpenAI GPT
app.post('/detect-clips', async (req, res) => {
  const { fullTranscriptionData } = req.body;
  const segments = fullTranscriptionData?.segments || [];
  const fullText = fullTranscriptionData?.text;

  if (!fullText) {
    console.log('No transcript text provided.');
    return res.status(400).json({ error: 'No transcript available for clip detection.' });
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

    // Define the payload to send to OpenAI's Chat Completions API
    const openaiPayload = {
      model: 'gpt-4o', // Using the gpt-4o model
      messages: [
        { role: 'system', content: 'You are an AI video clipper assistant. Your output MUST be a JSON array of clip objects. Only return the JSON array. DO NOT include any text before or after the JSON.' }, // Reinforce strict JSON output
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }, // Keeping this as it's what the API consistently asks for in your setup
      temperature: 0.7, // Controls creativity (0.0-2.0)
      max_tokens: 1500 // Maximum number of tokens in the AI's response
    };

    // DEBUGGING LOG: Print the exact payload being sent to OpenAI
    console.log('Payload sent to OpenAI Chat Completions:', JSON.stringify(openaiPayload, null, 2));


    const gptResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      openaiPayload, // Send the constructed payload
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const rawGptOutput = gptResponse.data.choices[0].message.content;
    console.log('Raw GPT Output:', rawGptOutput); // Critical log: check this output after running

    let suggestedClips = [];
    try {
      const parsedOutput = JSON.parse(rawGptOutput);

      // Robust parsing logic to handle various GPT output patterns
      if (Array.isArray(parsedOutput)) {
        suggestedClips = parsedOutput; // GPT returned a direct array (ideal)
      } else if (typeof parsedOutput === 'object' && parsedOutput !== null) {
        if (Array.isArray(parsedOutput.clips)) { // Check for { clips: [...] } pattern
          suggestedClips = parsedOutput.clips;
        } else { // Assume it's a single valid clip object and wrap it in an array
          if (
              typeof parsedOutput.title === 'string' &&
              typeof parsedOutput.description === 'string' &&
              typeof parsedOutput.startTimeSeconds === 'number' &&
              typeof parsedOutput.endTimeSeconds === 'number' &&
              typeof parsedOutput.reason === 'string'
          ) {
              suggestedClips = [parsedOutput];
              console.log("GPT returned a single valid clip object, wrapping it in an array.");
          } else {
            console.warn("GPT response was a JSON object but did not conform to expected clip structure. Returning empty array.");
            suggestedClips = [];
          }
        }
      } else {
        console.warn("GPT response was neither a JSON array nor a JSON object. Returning empty array.");
        suggestedClips = [];
      }

      // Final filter to ensure all items in the array are valid clip objects
      suggestedClips = suggestedClips.filter(clip =>
        typeof clip === 'object' && clip !== null &&
        typeof clip.title === 'string' &&
        typeof clip.description === 'string' &&
        typeof clip.startTimeSeconds === 'number' &&
        typeof clip.endTimeSeconds === 'number' &&
        typeof clip.reason === 'string'
      );

      if (suggestedClips.length === 0) {
        console.warn("No valid clips were generated or parsed from GPT's response after filtering.");
      }

    } catch (parseError) {
      console.error('Failed to parse GPT response JSON:', parseError);
      // If JSON parsing itself fails, return an empty array to gracefully handle the frontend
      return res.status(200).json({ clips: [], warning: 'Failed to parse AI clip suggestions. No clips generated.' });
    }

    res.json({ clips: suggestedClips });

  } catch (error) {
    console.error('Error detecting clips with GPT:');
    if (error.response?.data) {
      console.error('OpenAI GPT API Error Response:', error.response.data);
    } else {
      console.error('General Error:', error.message);
    }
    // Return a 500 error if the GPT API call itself failed (e.g., API key issue, rate limit)
    res.status(500).json({ error: 'Failed to detect clips due to an internal AI error.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});