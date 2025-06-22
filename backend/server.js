import express from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import dotenv from 'dotenv';
import cors from 'cors';
import { exec } from 'child_process'; // Import exec for running shell commands

dotenv.config(); // Load environment variables from .env file

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for all origins. In a production environment, you might
// want to restrict this to specific origins for security.
// Example: app.use(cors({ origin: 'http://localhost:5173' }));
app.use(cors());

// Multer storage setup: files will be saved in the 'uploads/' directory
const upload = multer({ dest: 'uploads/' });

// POST endpoint to handle video uploads and transcription
app.post('/upload', upload.single('file'), async (req, res) => {
  // Check if a file was actually uploaded
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  console.log('Received file for upload:', {
    fieldname: req.file.fieldname,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    path: req.file.path // Temporary path where Multer saved the file
  });

  const videoFilePath = req.file.path; // Path to the original uploaded video
  // Define the path for the extracted audio file (MP3 format)
  const audioOutputPath = `${req.file.path}.mp3`;

  try {
    // --- Step 1: Extract audio from the video using FFmpeg ---
    console.log(`Starting audio extraction from: ${videoFilePath}`);
    await new Promise((resolve, reject) => {
      // FFmpeg command to convert video to MP3 audio
      // -i: input file
      // -vn: disable video recording (extract audio only)
      // -acodec libmp3lame: specify MP3 encoder
      // -q:a 2: audio quality (0-9, lower is better quality for MP3)
      const ffmpegCommand = `ffmpeg -i "${videoFilePath}" -vn -acodec libmp3lame -q:a 2 "${audioOutputPath}"`;

      exec(ffmpegCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`FFmpeg audio extraction error: ${error.message}`);
          console.error(`FFmpeg stdout: ${stdout}`); // Log FFmpeg's standard output
          console.error(`FFmpeg stderr: ${stderr}`); // Log FFmpeg's standard error
          // Reject with a more specific error for debugging
          return reject(new Error(`FFmpeg failed to extract audio: ${error.message}`));
        }
        console.log('Audio extracted successfully to:', audioOutputPath);
        resolve(); // Resolve the promise if FFmpeg command succeeds
      });
    });

    // --- Step 2: Send the extracted audio to OpenAI Whisper API ---
    console.log('Sending extracted audio to OpenAI Whisper...');
    const formData = new FormData();
    // Append the extracted audio file to the form data
    formData.append('file', fs.createReadStream(audioOutputPath));
    formData.append('model', 'whisper-1'); // Specify the Whisper model

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, // Use your API key
          ...formData.getHeaders(), // Important for FormData to set correct Content-Type
        },
      }
    );

    console.log('Transcription received from Whisper.');
    // Send the transcript back to the frontend
    res.json({ transcript: response.data.text });

  } catch (error) {
    // Log the full error details for debugging purposes
    console.error('Error in video processing pipeline:');
    if (error.response?.data) {
      // If it's an Axios error from OpenAI, log their response
      console.error('OpenAI API Error Response:', error.response.data);
    } else {
      // Otherwise, log the general error message
      console.error('General Error:', error.message);
    }

    // Send a generic 500 error to the frontend (avoiding exposing internal details)
    res.status(500).json({ error: 'Failed to process video for transcription.' });

  } finally {
    // --- Step 3: Clean up temporary files ---
    // Ensure both the original uploaded video and the extracted audio file are deleted
    // This is crucial to prevent your 'uploads' directory from filling up
    if (fs.existsSync(videoFilePath)) {
      try {
        fs.unlinkSync(videoFilePath);
        console.log('Cleaned up original video file:', videoFilePath);
      } catch (err) {
        console.error('Error cleaning up original video file:', err);
      }
    }
    if (fs.existsSync(audioOutputPath)) {
      try {
        fs.unlinkSync(audioOutputPath);
        console.log('Cleaned up extracted audio file:', audioOutputPath);
      } catch (err) {
        console.error('Error cleaning up extracted audio file:', err);
      }
    }
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});