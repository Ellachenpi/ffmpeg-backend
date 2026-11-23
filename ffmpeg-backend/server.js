const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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

function getAudioDurationSec(filePath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err || !metadata || !metadata.format) return resolve(null);
            const dur = Number(metadata.format.duration);
            resolve(Number.isFinite(dur) ? dur : null);
        });
    });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || (file.fieldname === 'image' ? '.jpg' : '.mp3');
        cb(null, `${file.fieldname}_${Date.now()}_${Math.round(Math.random() * 1E9)}${ext}`);
    }
});

const upload = multer({ storage: storage });

const queue = [];
let isProcessing = false;
let activeCommand = null;
let currentProcessingJobId = null;

function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const task = queue.shift();

    const jobs = getJobs();
    if (jobs[task.jobId] && jobs[task.jobId].status === 'cancelled') {
        isProcessing = false;
        return processQueue();
    }

    runAudioCoreJob(task, () => {
        isProcessing = false;
        activeCommand = null;
        currentProcessingJobId = null;
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
    if (!code) return res.status(400).send('缺少授權碼 Code');

    try {
        const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
        const { tokens } = await oauth2Client.getToken(code);

        res.send(`
            <script>
                if (window.opener) {
                    window.opener.postMessage({ type: 'OAUTH_TOKENS', tokens: ${JSON.stringify(tokens)} }, '*');
                    window.close();
                } else {
                    document.write("授權成功！請關閉此視窗返回主頁面。");
                }
            </script>
        `);
    } catch (e) {
        console.error('Callback error:', e);
        res.status(500).send('授權失敗：' + e.message);
    }
});

app.post('/convert', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 10 }]), (req, res) => {
    try {
        if (!req.files || !req.files['image']) return res.status(400).send('缺少靜態圖片檔案');

        const tokensRaw = req.body.tokens;
        if (!tokensRaw) return res.status(400).send('未提供有效的 YouTube 授權 Token，請重新點擊授權');

        let tokens;
        try { tokens = typeof tokensRaw === 'string' ? JSON.parse(tokensRaw) : tokensRaw; } catch (e) {
            tokens = { access_token: tokensRaw };
        }

        const imageFile = req.files['image'][0];
        const ytTitle = req.body.title || 'My Audio Track';
        const ytDescription = req.body.description || 'Uploaded with Web App';
        const ytPrivacy = req.body.privacy || 'private';

        const createdJobIds = [];
        const audioFiles = req.files['audio'];
        if (!audioFiles || audioFiles.length === 0) return res.status(400).send('缺少音訊檔案');

        audioFiles.forEach((audioFile, index) => {
            const jobId = `job_${Date.now()}_${index + 1}`;
            const titleWithIndex = audioFiles.length > 1 ? `${ytTitle} (${index + 1}/${audioFiles.length})` : ytTitle;

            updateJob(jobId, { status: 'queued', progress: '排隊中...', fileName: audioFile.originalname, videoUrl: null, error: null });
            createdJobIds.push(jobId);

            queue.push({
                jobId, imageFile, audioFile,
                tokens, ytTitle: titleWithIndex, ytDescription, ytPrivacy
            });
        });

        res.json({ success: true, jobIds: createdJobIds });
        processQueue();

    } catch (err) {
        console.error('[伺服器例外錯誤]:', err);
        if (!res.headersSent) res.status(500).send('伺服器錯誤：' + err.message);
    }
});

app.post('/cancel/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    updateJob(jobId, { status: 'cancelled', progress: '任務已被取消' });

    const queueIndex = queue.findIndex(t => t.jobId === jobId);
    if (queueIndex !== -1) queue.splice(queueIndex, 1);

    if (currentProcessingJobId === jobId && activeCommand) {
        try { activeCommand.kill('SIGKILL'); } catch (e) { console.error('Kill error:', e); }
    }

    res.json({ success: true, message: `任務 ${jobId} 已取消` });
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

async function runAudioCoreJob(task, next) {
    const { jobId, imageFile, audioFile, tokens, ytTitle, ytDescription, ytPrivacy } = task;

    currentProcessingJobId = jobId;
    const durationSec = await getAudioDurationSec(audioFile.path);
    const durationText = durationSec ? `${Math.floor(durationSec / 60)}m${Math.round(durationSec % 60)}s` : '未知';

    console.log(`[任務開始] JobID: ${jobId}, 檔案: ${audioFile.originalname}, 音訊時長: ${durationText}`);
    updateJob(jobId, { status: 'processing', progress: `00:00:00 / ${durationText} (1080p 壓碼中)` });

    const tempMp4Path = path.join(uploadDir, `upload_${jobId}.mp4`);
    let command = ffmpeg();
    activeCommand = command;

    command
        .input(imageFile.path)
        .inputOptions(['-loop 1', '-framerate 1/30']) // 每 30 秒 1 幀
        .input(audioFile.path)
        .videoCodec('libx264')
        // 1920x1080 等
