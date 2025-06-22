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

app.use(express.json());
app.use(cors());

const upload = multer({ dest: 'uploads/' });

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
      // FFmpeg command to convert video to MP3 audio
      const ffmpegCommand = `ffmpeg -i "${videoFilePath}" -vn -acodec libmp3lame -q:a 2 "${audioOutputPath}"`;

      exec(ffmpegCommand, (error) => {
        if (error) {
          console.error('FFmpeg error:', error.message);
          return reject(new Error(`FFmpeg failed: ${error.message}`));
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
          response_format: 'verbose_json' // Keep this for detailed Whisper output segments
        }
      }
    );

    console.log('Whisper transcription complete.');
    res.json({ fullTranscriptionData: response.data });

  } catch (error) {
    console.error('Error during /upload:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to process video.' });
  } finally {
    try {
      if (fs.existsSync(videoFilePath)) fs.unlinkSync(videoFilePath);
      if (fs.existsSync(audioOutputPath)) fs.unlinkSync(audioOutputPath);
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError.message);
    }
  }
});

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
You are an AI video editor. Identify 1-3 short video clips (10 to 60 seconds) from the following transcript.
Provide ONLY a JSON array of objects. **ALWAYS ensure the top-level response is a JSON array, even if it contains only one clip object.** Each object in the array should have the following keys:
- "title": "string",
- "description": "string",
- "startTimeSeconds": float,
- "endTimeSeconds": float,
- "reason": "string"

Transcript:
${fullText}

Segments:
${segments.map(s => `[${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s] ${s.text}`).join('\n')}
    `;

    const gptResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are an AI video clipper assistant. Output must be a JSON array. DO NOT include any text before or after the JSON. Only return the JSON array.' },
          { role: 'user', content: prompt }
        ],
        // CORRECTED: Use 'json' string for response_format with Chat Completions API for gpt-4o
        response_format: 'json',
        temperature: 0.7,
        max_tokens: 1500
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const rawGptOutput = gptResponse.data.choices[0].message.content;
    console.log('Raw GPT Output:', rawGptOutput);

    let suggestedClips = [];
    try {
      const parsedOutput = JSON.parse(rawGptOutput);

      // Robust parsing logic to handle various GPT output patterns
      if (Array.isArray(parsedOutput)) {
        suggestedClips = parsedOutput;
      } else if (typeof parsedOutput === 'object' && parsedOutput !== null) {
        // If GPT wrapped it in an object like { clips: [...] }
        if (Array.isArray(parsedOutput.clips)) {
          suggestedClips = parsedOutput.clips;
        } else {
          // If it's a single valid clip object (as seen in previous debugging)
          if (
              typeof parsedOutput.title === 'string' &&
              typeof parsedOutput.description === 'string' &&
              typeof parsedOutput.startTimeSeconds === 'number' &&
              typeof parsedOutput.endTimeSeconds === 'number' &&
              typeof parsedOutput.reason === 'string'
          ) {
              suggestedClips = [parsedOutput]; // Wrap the single object in an array
              console.log("GPT returned a single valid clip object, successfully wrapped it in an array.");
          } else {
              console.warn("GPT response was a JSON object but did not conform to expected clip structure. Returning empty array.");
              suggestedClips = [];
          }
        }
      } else {
        console.warn("GPT response was neither a JSON array nor a JSON object. Returning empty array.");
        suggestedClips = [];
      }

      // Final filter to ensure all items are valid clip objects and clean
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
    res.status(500).json({ error: 'Failed to detect clips.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});