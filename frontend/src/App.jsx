// App.jsx
import React, { useState } from 'react';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [clips, setClips] = useState([]);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
  };

  const handleUpload = async () => {
    if (!file) {
      alert('Please select a file first!');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);  // MUST MATCH upload.single('file')

    try {
      const response = await fetch('http://localhost:5000/upload', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const data = await response.json();
      setTranscript(data.transcript);
      setClips(data.clips || []);

    } catch (err) {
      console.error('Error uploading video:', err);
      alert('Upload failed!');
    }
  };

  return (
    <div className="app">
      <h1>🎬 AI Video Clipper - Upload Video</h1>

      <input type="file" onChange={handleFileChange} />
      <button onClick={handleUpload}>Upload & Transcribe</button>

      <h2>Transcript:</h2>
      <textarea value={transcript} readOnly rows="10" cols="60" />

      <h2>Suggested Clips:</h2>
      {clips.length > 0 ? (
        <ul>
          {clips.map((clip, index) => (
            <li key={index}>
              <strong>{clip.title}</strong> — Start: {clip.start}, End: {clip.end}
            </li>
          ))}
        </ul>
      ) : (
        <p>No clips found yet.</p>
      )}
    </div>
  );
}

export default App;
