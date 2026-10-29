<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Audio & Image to Video Generator (Auto Close Auth)</title>
    <style>
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif; background: #f2f2f7; margin: 0; padding: 16px; display: flex; justify-content: center; }
        .container { background: white; max-width: 500px; width: 100%; padding: 20px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
        h2 { text-align: center; margin-bottom: 20px; color: #1c1c1e; font-size: 20px; }
        .form-group { margin-bottom: 16px; }
        label { display: block; font-weight: 600; margin-bottom: 6px; color: #3a3a3c; font-size: 14px; }
        input[type="text"], textarea, select { width: 100%; padding: 12px; border: 1px solid #c7c7cc; border-radius: 10px; font-size: 15px; background: #fff; appearance: none; }
        input[type="file"] { display: block; width: 100%; padding: 10px; border: 1px solid #c7c7cc; border-radius: 10px; background: #f2f2f7; font-size: 14px; }
        button { width: 100%; padding: 14px; background: #007aff; color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; margin-top: 10px; }
        button:active { opacity: 0.7; }
        button:disabled { background: #aeaeb2; cursor: not-allowed; }
        .btn-auth { background: #34c759; margin-bottom: 16px; }
        .auth-status { text-align: center; font-size: 14px; color: #34c759; font-weight: 600; margin-bottom: 12px; padding: 10px; background: #e8f8ee; border-radius: 10px; display: none; }
        .source-toggle { display: flex; gap: 8px; margin-bottom: 12px; }
        .toggle-btn { flex: 1; padding: 8px; font-size: 13px; text-align: center; border: 1px solid #007aff; border-radius: 8px; color: #007aff; cursor: pointer; font-weight: 600; }
        .toggle-btn.active { background: #007aff; color: white; }
        .job-card { background: #e5f1ff; border: 1px solid #007aff; padding: 12px; border-radius: 10px; margin-top: 12px; font-size: 13px; color: #004085; display: none; }
        .task-list { margin-top: 16px; }
        .task-item { background: #f2f2f7; border: 1px solid #d1d1d6; border-radius: 10px; padding: 12px; margin-bottom: 8px; font-size: 13px; }
        .task-name { font-weight: 600; color: #1c1c1e; margin-bottom: 4px; word-break: break-all; }
        .task-status { color: #007aff; font-weight: 500; }
        .time-box { display: flex; gap: 8px; }
    </style>
</head>
<body>

<div class="container">
    <h2>🎵 音源+封面圖（自動關閉授權版）</h2>

    <button id="authBtn" class="btn-auth">🔑 第一步：連結 YouTube 帳號</button>
    <div id="authSuccessMsg" class="auth-status">✅ 已連結 YouTube 帳號 <a href="#" id="reAuthLink" style="font-size:12px; color:#007aff; margin-left:8px;">重新連結</a></div>

    <div class="form-group">
        <label>1. 選擇靜態封面圖片 (JPG / PNG)</label>
        <input type="file" id="imageInput" accept="image/*">
    </div>

    <div class="form-group">
        <label>2. 選擇音源模式</label>
        <div class="source-toggle">
            <div class="toggle-btn active" id="btnModeFile">📁 本地音檔 (可多選)</div>
            <div class="toggle-btn" id="btnModeYt">🔗 YouTube 區間</div>
        </div>
    </div>

    <div id="sectionFile">
        <div class="form-group">
            <label>3. 選擇音訊檔案 (按住可多選 MP3/WAV)</label>
            <input type="file" id="audioInput" accept="audio/*, .mp3, .wav, .m4a" multiple>
        </div>
    </div>

    <div id="sectionYt" style="display: none;">
        <div class="form-group">
            <label>3. YouTube 影片網址 (支援不公開)</label>
            <input type="text" id="ytUrlInput" placeholder="https://www.youtube.com/watch?v=...">
        </div>
        <div class="form-group">
            <label>4. 截取時間區間 (hh:mm:ss)</label>
            <div class="time-box">
                <input type="text" id="startTimeInput" placeholder="開始 (00:00:00)" value="00:00:00">
                <input type="text" id="endTimeInput" placeholder="結束 (00:05:00)" value="00:05:00">
            </div>
        </div>
    </div>

    <div class="form-group">
        <label>5. YouTube 影片標題</label>
        <input type="text" id="ytTitle" value="My Audio Track">
    </div>

    <div class="form-group">
        <label>6. YouTube 影片說明</label>
        <textarea id="ytDescription" rows="2">Uploaded with Web App</textarea>
    </div>

    <div class="form-group">
        <label>7. 隱私設定</label>
        <select id="ytPrivacy">
            <option value="private" selected>私人 (Private)</option>
            <option value="unlisted">不公開 (Unlisted)</option>
            <option value="public">公開 (Public)</option>
        </select>
    </div>

    <button id="convertBtn">🚀 提交至雲端背景佇列</button>

    <div class="job-card" id="jobCard">
        📱 <b>背景佇列已啟動！</b><br>
        您可以自由關閉網頁或切換 App，系統將自動壓碼發布。
    </div>

    <div class="task-list" id="taskList"></div>
</div>

<script>
    const RENDER_BACKEND_URL = 'https://ffmpeg-backend-72s6.onrender.com';
    const CLIENT_ID = '124484081362-42ffam7ts867htags708jsb4rg88vl4e.apps.googleusercontent.com';
    const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

    // 關鍵修復：如果是在 OAuth 彈出視窗內，拿到 Token 後儲存並自動關閉視窗！
    if (window.location.hash.includes('access_token')) {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const token = params.get('access_token');
        if (token) {
            localStorage.setItem('yt_access_token', token);
            window.close(); // 自動關閉視窗
        }
    }

    let userAccessToken = localStorage.getItem('yt_access_token') || null;
    let pollTimer = null;
    let currentMode = 'file';

    const btnModeFile = document.getElementById('btnModeFile');
    const btnModeYt = document.getElementById('btnModeYt');
    const sectionFile = document.getElementById('sectionFile');
    const sectionYt = document.getElementById('sectionYt');
    const authBtn = document.getElementById('authBtn');
    const authSuccessMsg = document.getElementById('authSuccessMsg');
    const reAuthLink = document.getElementById('reAuthLink');
    const convertBtn = document.getElementById('convertBtn');
    const jobCard = document.getElementById('jobCard');
    const taskList = document.getElementById('taskList');

    btnModeFile.addEventListener('click', () => {
        currentMode = 'file';
        btnModeFile.classList.add('active');
        btnModeYt.classList.remove('active');
        sectionFile.style.display = 'block';
        sectionYt.style.display = 'none';
    });

    btnModeYt.addEventListener('click', () => {
        currentMode = 'youtube';
        btnModeYt.classList.add('active');
        btnModeFile.classList.remove('active');
        sectionFile.style.display = 'none';
        sectionYt.style.display = 'block';
    });

    function updateAuthUI() {
        if (userAccessToken) {
            authBtn.style.display = 'none';
            authSuccessMsg.style.display = 'block';
        } else {
            authBtn.style.display = 'block';
            authSuccessMsg.style.display = 'none';
        }
    }
    updateAuthUI();

    reAuthLink.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem('yt_access_token');
        userAccessToken = null;
        updateAuthUI();
        triggerAuth();
    });

    function triggerAuth() {
        let redirectUri = window.location.href.split('#')[0].split('?')[0];
        if (redirectUri.endsWith('/')) redirectUri = redirectUri.slice(0, -1);

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `client_id=${encodeURIComponent(CLIENT_ID)}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=token` +
            `&scope=${encodeURIComponent(SCOPE)}` +
            `&prompt=consent`;

        const popup = window.open(authUrl, 'GoogleAuth', 'width=500,height=600');
        
        // 輪詢檢測 LocalStorage，當彈窗寫入 token 關閉後立刻自動切換 UI
        const checkTimer = setInterval(() => {
            const storedToken = localStorage.getItem('yt_access_token');
            if (storedToken) {
                userAccessToken = storedToken;
                updateAuthUI();
                clearInterval(checkTimer);
                if (popup && !popup.closed) popup.close();
            }
        }, 500);
    }

    authBtn.addEventListener('click', triggerAuth);

    const savedJobIds = JSON.parse(localStorage.getItem('current_batch_ids') || '[]');
    if (savedJobIds.length > 0) startPolling(savedJobIds);

    convertBtn.addEventListener('click', () => {
        const imgFile = document.getElementById('imageInput').files[0];
        if (!imgFile) { alert('請選擇圖片！'); return; }
        if (!userAccessToken) { alert('請先點擊最上方的「第一步：連結 YouTube 帳號」進行授權！'); return; }

        const formData = new FormData();
        formData.append('image', imgFile);
        formData.append('sourceType', currentMode);

        if (currentMode === 'file') {
            const audioFiles = document.getElementById('audioInput').files;
            if (audioFiles.length === 0) { alert('請選擇至少一個音檔！'); return; }
            for (let i = 0; i < audioFiles.length; i++) formData.append('audio', audioFiles[i]);
        } else {
            const ytUrl = document.getElementById('ytUrlInput').value;
            if (!ytUrl) { alert('請輸入 YouTube 網址！'); return; }
            formData.append('ytUrl', ytUrl);
            formData.append('startTime', document.getElementById('startTimeInput').value || '00:00:00');
            formData.append('endTime', document.getElementById('endTimeInput').value || '00:05:00');
        }

        formData.append('accessToken', user
