import React, { useState } from 'react';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [clips, setClips] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploadedVideoTempPath, setUploadedVideoTempPath] = useState(null);
  const [downloadingClipTitle, setDownloadingClipTitle] = useState(null);


  const handleUpload = async () => {
    if (!file) {
      alert('Please select a video file!');
      return;
    }

    setLoading(true);
    setError('');
    setTranscript('');
    setClips([]);
    setUploadedVideoTempPath(null);
    setDownloadingClipTitle(null);


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

      setUploadedVideoTempPath(uploadData.uploadedFilePath);

      console.log('Transcript received:', uploadData.fullTranscriptionData);
      setTranscript(uploadData.fullTranscriptionData.text);

      console.log('Requesting clip detection...');
      const detectClipsResponse = await fetch('http://localhost:5000/detect-clips', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fullTranscriptionData: uploadData.fullTranscriptionData }),
      });

      const clipsData = await detectClipsResponse.json();
      if (!detectClipsResponse.ok) throw new Error(clipsData.error);

      const clipsWithPaths = clipsData.clips.map(clip => ({
          ...clip,
          originalVideoTempPath: uploadData.uploadedFilePath
      }));

      console.log('Detected clips:', clipsWithPaths);
      setClips(clipsWithPaths);

    } catch (err) {
      console.error('Upload or clip detection error:', err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadClip = async (clip) => {
      if (downloadingClipTitle === clip.title) {
          return;
      }
      if (!clip.originalVideoTempPath) {
          alert('Original video path is missing. Cannot download clip.');
          return;
      }

      setDownloadingClipTitle(clip.title);

      try {
          console.log(`Requesting backend to cut clip: "${clip.title}"`);
          const response = await fetch('http://localhost:5000/cut-clip', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                  originalVideoTempPath: clip.originalVideoTempPath,
                  clipTitle: clip.title,
                  startTimeSeconds: clip.startTimeSeconds,
                  endTimeSeconds: clip.endTimeSeconds,
              }),
          });

          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Failed to cut clip.');

          console.log('Clip cutting successful. Download URL:', data.downloadUrl);
          window.open(data.downloadUrl, '_blank');
          alert(`"${clip.title}" clip is ready for download!`);

      } catch (err) {
          console.error('Error downloading clip:', err);
          alert('Failed to download clip: ' + err.message);
      } finally {
          setDownloadingClipTitle(null);
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
        {loading ? 'Processing...' : 'Upload & Detect Clips'}
      </button>

      {loading && <p>Processing... please wait.</p>}
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
              <button
                onClick={() => handleDownloadClip(clip)}
                disabled={downloadingClipTitle === clip.title}
              >
                {downloadingClipTitle === clip.title ? 'Downloading...' : 'Download Clip'}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !loading && <p>No clips detected yet.</p>
      )}
    </div>
  );
}

export default App;