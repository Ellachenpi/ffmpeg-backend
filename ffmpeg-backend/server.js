const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = '124484081362-42ffam7ts867htags708jsb4rg88vl4e.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'https://ffmpeg-backend-72s6.onrender.com/auth/callback';

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const jobsFilePath = path.join(__dirname, 'jobs.json');

function getJobs() {
    if (!fs.existsSync(jobsFilePath)) return {};
    try { return JSON.parse(fs.readFileSync(jobsFilePath, 'utf8')); } catch (e) { return {}; }
}

function updateJob(jobId, data) {
    const jobs = getJobs();
    jobs[jobId] = { ...(jobs[jobId] || {}), ...data, updatedAt: new Date() };
    fs.writeFileSync(jobsFilePath, JSON.stringify(jobs, null, 2));
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || (file.fieldname === 'image' ? '.jpg' : '.mp3');
        cb(null, `${file.fieldname}_${Date.now()}_${Math.round(Math.random() * 1E9)}${ext}`);
    }
});

const upload = multer({ storage: storage });

// 佇列管理
const queue = [];
let isProcessing = false;

function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const task = queue.shift();
    runMemoryControlledJob(task, () => {
        isProcessing = false;
        processQueue();
    });
}

app.get('/auth/url', (req, res) => {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/youtube.upload']
    });
    res.json({ url: authUrl });
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('缺少 Authorization Code');
    try {
        const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
        const { tokens } = await oauth2Client.getToken(code);
        res.send(`
            <script>
                if (window.opener) {
                    window.opener.postMessage({ type: 'OAUTH_SUCCESS', tokens: ${JSON.stringify(tokens)} }, '*');
                    window.close();
                } else { document.write('授權成功！請返回原頁面。'); }
            </script>
        `);
    } catch (err) {
        res.status(500).send('授權失敗：' + err.message);
    }
});

app.post('/convert', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 10 }]), (req, res) => {
    try {
        if (!req.files || !req.files['image']) return res.status(400).send('缺少靜態圖片檔案');

        const refreshToken = req.body.refreshToken;
        const accessToken = req.body.accessToken;
        if (!refreshToken && !accessToken) return res.status(400).send('未提供有效的 YouTube 授權 Token');

        const imageFile = req.files['image'][0];
        const sourceType = req.body.sourceType || 'file'; // 'file' 或 'youtube'
        const ytTitle = req.body.title || 'My Audio Track';
        const ytDescription = req.body.description || 'Uploaded with Web App';
        const ytPrivacy = req.body.privacy || 'private';

        const createdJobIds = [];

        if (sourceType === 'youtube') {
            // YouTube 網址區間擷取模式
            const ytUrl = req.body.ytUrl;
            const startTime = req.body.startTime || '00:00:00';
            const endTime = req.body.endTime || '00:05:00';

            if (!ytUrl) return res.status(400).send('缺少 YouTube 影片網址');

            const jobId = `job_${Date.now()}_yt`;
            updateJob(jobId, { status: 'queued', progress: '排隊中...', fileName: `YouTube 區間 (${startTime} ~ ${endTime})`, videoUrl: null, error: null });
            createdJobIds.push(jobId);

            queue.push({
                jobId, imageFile, sourceType: 'youtube', ytUrl, startTime, endTime,
                refreshToken, accessToken, ytTitle, ytDescription, ytPrivacy
            });

        } else {
            // 上傳本地音檔模式
            const audioFiles = req.files['audio'];
            if (!audioFiles || audioFiles.length === 0) return res.status(400).send('缺少音訊檔案');

            audioFiles.forEach((audioFile, index) => {
                const jobId = `job_${Date.now()}_${index + 1}`;
                const titleWithIndex = audioFiles.length > 1 ? `${ytTitle} (${index + 1}/${audioFiles.length})` : ytTitle;

                updateJob(jobId, { status: 'queued', progress: '排隊中...', fileName: audioFile.originalname, videoUrl: null, error: null });
                createdJobIds.push(jobId);

                queue.push({
                    jobId, imageFile, sourceType: 'file', audioFile,
                    refreshToken, accessToken, ytTitle: titleWithIndex, ytDescription, ytPrivacy
                });
            });
        }

        res.json({ success: true, jobIds: createdJobIds });
        processQueue();

    } catch (err) {
        console.error('[伺服器例外錯誤]:', err);
        if (!res.headersSent) res.status(500).send('伺服器錯誤：' + err.message);
    }
});

app.get('/status/batch', (req, res) => {
    const idsParam = req.query.ids;
    if (!idsParam) return res.status(400).json({ error: '缺少 ids 參數' });
    const jobIds = idsParam.split(',');
    const jobs = getJobs();
    const result = {};
    jobIds.forEach(id => { if (jobs[id]) result[id] = jobs[id]; });
    res.json(result);
});

function runMemoryControlledJob(task, next) {
    const { jobId, imageFile, sourceType, audioFile, ytUrl, startTime, endTime, refreshToken, accessToken, ytTitle, ytDescription, ytPrivacy } = task;

    console.log(`[佇列任務開始] JobID: ${jobId}, 模式: ${sourceType}`);
    updateJob(jobId, { status: 'processing', progress: '00:00:00' });

    const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

    const videoStream = new PassThrough({ highWaterMark: 1024 * 1024 });
    const youtube = google.youtube({ version: 'v3', auth: auth });

    const uploadPromise = youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
            snippet: { title: ytTitle, description: ytDescription, categoryId: '10' },
            status: { privacyStatus: ytPrivacy }
        },
        media: { body: videoStream }
    });

    let command = ffmpeg();

    if (sourceType === 'youtube') {
        // 使用 yt-dlp 抓取音訊網址並直接切片串流
        const ytdlp = spawn('yt-dlp', ['-g', '-f', 'bestaudio', ytUrl]);
        let audioUrl = '';

        ytdlp.stdout.on('data', (data) => { audioUrl += data.toString().trim(); });
        ytdlp.on('close', (code) => {
            if (code !== 0 || !audioUrl) {
                updateJob(jobId, { status: 'error', error: '無法解析 YouTube 影片音訊網址' });
                return next();
            }

            command
                .input(imageFile.path)
                .inputOptions(['-loop 1'])
                .input(audioUrl)
                .inputOptions([`-ss ${startTime}`, `-to ${endTime}`])
                .videoCodec('libx264')
                .size('480x270')
                .fps(1)
                .outputOptions(['-preset ultrafast', '-tune stillimage', '-pix_fmt yuv420p', '-threads 1', '-f mp4', '-movflags frag_keyframe+empty_moov'])
                .audioCodec('aac')
                .audioBitrate('128k')
                .on('progress', p => p.timemark && updateJob(jobId, { progress: p.timemark }))
                .on('end', async () => handleUploadSuccess(uploadPromise, jobId, next))
                .on('error', err => handleUploadError(err, jobId, next))
                .pipe(videoStream, { end: true });
        });
    } else {
        // 檔案模式
        command
            .input(imageFile.path)
            .inputOptions(['-loop 1'])
            .input(audioFile.path)
            .videoCodec('libx264')
            .size('480x270')
            .fps(1)
            .outputOptions(['-preset ultrafast', '-tune stillimage', '-pix_fmt yuv420p', '-shortest', '-threads 1', '-f mp4', '-movflags frag_keyframe+empty_moov'])
            .audioCodec('copy')
            .on('progress', p => p.timemark && updateJob(jobId, { progress: p.timemark }))
            .on('end', async () => {
                cleanupAudio(audioFile.path);
                handleUploadSuccess(uploadPromise, jobId, next);
            })
            .on('error', err => {
                cleanupAudio(audioFile.path);
                handleUploadError(err, jobId, next);
            })
            .pipe(videoStream, { end: true });
    }
}

async function handleUploadSuccess(uploadPromise, jobId, next) {
    updateJob(jobId, { progress: '正在完成 YouTube 發布...' });
    try {
        const uploadRes = await uploadPromise;
        updateJob(jobId, { status: 'completed', videoUrl: `https://youtu.be/${uploadRes.data.id}` });
    } catch (ytErr) {
        updateJob(jobId, { status: 'error', error: 'YouTube 上傳失敗：' + (ytErr.message || '授權失效') });
    } finally {
        next();
    }
}

function handleUploadError(err, jobId, next) {
    updateJob(jobId, { status: 'error', error: '轉碼失敗：' + err.message });
    next();
}

function cleanupAudio(audioPath) {
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
