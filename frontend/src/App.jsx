import React, { useState } from 'react';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [clips, setClips] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploadedVideoTempPath, setUploadedVideoTempPath] = useState(null);

  // --- NEW STATE FOR USER OPTIONS ---
  const [clipOption, setClipOption] = useState('aiPick'); // 'aiPick' or 'userChoice'
  const [desiredClipCount, setDesiredClipCount] = useState(3); // Default for user choice
  const [desiredClipDuration, setDesiredClipDuration] = useState(30); // Default for user choice (in seconds)
  // --- END NEW STATE ---

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

      console.log('Requesting clip detection and batch cutting...');
      const detectClipsResponse = await fetch('http://localhost:5000/detect-clips', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            fullTranscriptionData: uploadData.fullTranscriptionData,
            originalVideoTempPath: uploadData.uploadedFilePath,
            clipOption: clipOption,
            desiredClipCount: desiredClipCount,
            desiredClipDuration: desiredClipDuration
        }),
      });

      // FIX HERE: Corrected variable name from detectClpsResponse to detectClipsResponse
      const clipsData = await detectClipsResponse.json();
      if (!detectClipsResponse.ok) throw new Error(clipsData.error);

      console.log('Detected and (attempted) cut clips:', clipsData.clips);
      setClips(clipsData.clips);

    } catch (err) {
      console.error('Upload or clip processing error:', err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

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

      <div className="input-section">
        <input type="file" accept="video/*" onChange={(e) => setFile(e.target.files[0])} disabled={loading} />
        <button onClick={handleUpload} disabled={loading}>
          {loading ? 'Processing...' : 'Upload & Auto-Cut Clips'}
        </button>
      </div>

      {/* --- NEW UI FOR CLIP OPTIONS --- */}
      <div className="clip-options-section">
        <h3>Clip Generation Options:</h3>
        <div>
          <label>
            <input
              type="radio"
              value="aiPick"
              checked={clipOption === 'aiPick'}
              onChange={() => setClipOption('aiPick')}
              disabled={loading}
            />
            AI's Best Pick (1-3 clips, default duration)
          </label>
        </div>
        <div>
          <label>
            <input
              type="radio"
              value="userChoice"
              checked={clipOption === 'userChoice'}
              onChange={() => setClipOption('userChoice')}
              disabled={loading}
            />
            User Choice:
          </label>
          {clipOption === 'userChoice' && (
            <div className="user-choice-controls">
              <label>
                Number of Clips:
                <select
                  value={desiredClipCount}
                  onChange={(e) => setDesiredClipCount(Number(e.target.value))}
                  disabled={loading}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(num => (
                    <option key={num} value={num}>{num}</option>
                  ))}
                  <option value="max">Max AI picks</option> {/* Can add "Max AI picks" too */}
                </select>
              </label>
              <label>
                Duration (seconds per clip):
                <select
                  value={desiredClipDuration}
                  onChange={(e) => setDesiredClipDuration(Number(e.target.value))}
                  disabled={loading}
                >
                  <option value={10}>~10 seconds</option>
                  <option value={20}>~20 seconds</option>
                  <option value={30}>~30 seconds</option>
                  <option value={45}>~45 seconds</option>
                  <option value={60}>~60 seconds</option>
                  <option value={90}>~90 seconds</option>
                </select>
              </label>
            </div>
          )}
        </div>
      </div>
      {/* --- END NEW UI --- */}

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