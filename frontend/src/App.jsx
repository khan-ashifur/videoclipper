import React, { useState } from 'react';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [clips, setClips] = useState([]); // This will now directly hold clips with download URLs
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // uploadedVideoTempPath is still used to send to backend, but its primary purpose
  // for frontend-triggered cutting is gone as cutting is now batched on backend.
  const [uploadedVideoTempPath, setUploadedVideoTempPath] = useState(null);


  const handleUpload = async () => {
    if (!file) {
      alert('Please select a video file!');
      return;
    }

    setLoading(true);
    setError('');
    setTranscript('');
    setClips([]);
    setUploadedVideoTempPath(null); // Clear previous path for new upload


    const formData = new FormData();
    formData.append('file', file);

    try {
      console.log('Uploading video...');
      const uploadResponse = await fetch('http://localhost:5000/upload', {
        method: 'POST',
        body: formData,
      });

      const uploadData = await uploadResponse.json();
      if (!uploadResponse.ok) throw new Error(uploadData.error);

      // Store the temporary path from backend's /upload response
      setUploadedVideoTempPath(uploadData.uploadedFilePath);

      console.log('Transcript received:', uploadData.fullTranscriptionData);
      setTranscript(uploadData.fullTranscriptionData.text);

      console.log('Requesting clip detection and batch cutting...');
      // Frontend now sends full transcription data AND the temporary video path
      const detectClipsResponse = await fetch('http://localhost:5000/detect-clips', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            fullTranscriptionData: uploadData.fullTranscriptionData,
            originalVideoTempPath: uploadData.uploadedFilePath // Send the path for backend to cut
        }),
      });

      const clipsData = await detectClipsResponse.json();
      if (!detectClipsResponse.ok) throw new Error(clipsData.error);

      console.log('Detected and (attempted) cut clips:', clipsData.clips);
      setClips(clipsData.clips); // Clips now directly contain download URLs

    } catch (err) {
      console.error('Upload or clip processing error:', err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Simplified handleDownloadClip: now just opens the URL
  const handleDownloadClip = (clip) => {
      if (clip.downloadUrl) {
          window.open(clip.downloadUrl, '_blank');
      } else {
          alert('Download URL not available for this clip.');
      }
  };

  const formatTime = (seconds) => {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="app">
      <h1>🎬 AI Video Clipper</h1>

      <input type="file" accept="video/*" onChange={(e) => setFile(e.target.files[0])} disabled={loading} />
      <button onClick={handleUpload} disabled={loading}>
        {loading ? 'Processing...' : 'Upload & Auto-Cut Clips'}
      </button>

      {loading && <p>Processing... please wait. This might take a moment for longer videos.</p>}
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}

      <h2>Transcript:</h2>
      <textarea rows="6" value={transcript} readOnly style={{ width: '100%' }} />

      <h2>Suggested Clips:</h2>
      {clips.length > 0 ? (
        <ul>
          {clips.map((clip, index) => (
            <li key={index} style={{ marginBottom: '10px' }}>
              <h3>{clip.title}</h3>
              <p>{clip.description}</p>
              <p>Start: {formatTime(clip.startTimeSeconds)} | End: {formatTime(clip.endTimeSeconds)}</p>
              <p>Reason: {clip.reason}</p>
              {clip.downloadUrl ? (
                  <button onClick={() => handleDownloadClip(clip)}>Download Clip</button>
              ) : (
                  <p style={{ color: 'orange' }}>Clip cut failed or URL not available.</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !loading && transcript && <p>No clips detected or cut yet. Try a different video?</p>
      )}
      {!loading && !transcript && <p>Upload a video to see transcripts and auto-cut clips.</p>}
    </div>
  );
}

export default App;