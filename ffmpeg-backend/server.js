const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = '124484081362-42ffam7ts867htags708jsb4rg88vl4e.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'https://ffmpeg-backend-72s6.onrender.com/auth/callback';

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const jobsFilePath = path.join(__dirname, 'jobs.json');

function getJobs() {
    if (!fs.existsSync(jobsFilePath)) return {};
    try {
        return JSON.parse(fs.readFileSync(jobsFilePath, 'utf8'));
    } catch (e) {
        return {};
    }
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

// 佇列管理：確保多個音檔依序處理，不併發吃滿記憶體
const queue = [];
let isProcessing = false;

function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const task = queue.shift();
    runMemoryControlledJob(task, () => {
        isProcessing = false;
        processQueue(); // 處理下一個任務
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
                } else {
                    document.write('授權成功！請返回原頁面。');
                }
            </script>
        `);
    } catch (err) {
        console.error('Exchange token error:', err);
        res.status(500).send('授權失敗：' + err.message);
    }
});

// 支援單個或多個音檔批次建立任務
app.post('/convert', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 10 }]), (req, res) => {
    try {
        if (!req.files || !req.files['image'] || !req.files['audio']) {
            return res.status(400).send('缺少圖片或音訊檔案');
        }

        const refreshToken = req.body.refreshToken;
        const accessToken = req.body.accessToken;

        if (!refreshToken && !accessToken) {
            return res.status(400).send('未提供有效的 YouTube 授權 Token');
        }

        const imageFile = req.files['image'][0];
        const audioFiles = req.files['audio'];
        const ytTitle = req.body.title || 'My Audio Track';
        const ytDescription = req.body.description || 'Uploaded with Web App';
        const ytPrivacy = req.body.privacy || 'private';

        const createdJobIds = [];

        // 為每一個音檔建立獨立 Job
        audioFiles.forEach((audioFile, index) => {
            const jobId = `job_${Date.now()}_${index + 1}`;
            const titleWithIndex = audioFiles.length > 1 ? `${ytTitle} (${index + 1}/${audioFiles.length})` : ytTitle;

            updateJob(jobId, {
                status: 'queued',
                progress: '排隊中...',
                fileName: audioFile.originalname,
                videoUrl: null,
                error: null
            });

            createdJobIds.push(jobId);

            // 加入背景執行佇列
            queue.push({
                jobId,
                imageFile,
                audioFile,
                refreshToken,
                accessToken,
                ytTitle: titleWithIndex,
                ytDescription,
                ytPrivacy
            });
        });

        // 立即回應手機所有的 Job ID 陣列
        res.json({ success: true, jobIds: createdJobIds });

        // 啟動佇列處理器
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

    jobIds.forEach(id => {
        if (jobs[id]) result[id] = jobs[id];
    });

    res.json(result);
});

function runMemoryControlledJob(task, next) {
    const { jobId, imageFile, audioFile, refreshToken, accessToken, ytTitle, ytDescription, ytPrivacy } = task;

    console.log(`[佇列任務開始] JobID: ${jobId}, 檔案: ${audioFile.originalname}`);
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

    let command = ffmpeg()
        .input(imageFile.path)
        .inputOptions(['-loop 1'])
        .input(audioFile.path)
        .videoCodec('libx264')
        .size('480x270')
        .fps(1)
        .outputOptions([
            '-preset ultrafast',
            '-tune stillimage',
            '-pix_fmt yuv420p',
            '-shortest',
            '-threads 1',
            '-f mp4',
            '-movflags frag_keyframe+empty_moov'
        ])
        .audioCodec('copy');

    command
        .on('progress', (progress) => {
            if (progress.timemark) {
                updateJob(jobId, { progress: progress.timemark });
            }
        })
        .on('end', async () => {
            console.log(`[${jobId} 轉碼完成] 等待 YouTube 發布...`);
            updateJob(jobId, { progress: '正在完成 YouTube 發布...' });
            try {
                const uploadRes = await uploadPromise;
                console.log(`[${jobId} 上傳成功] Video ID: ${uploadRes.data.id}`);
                updateJob(jobId, { status: 'completed', videoUrl: `https://youtu.be/${uploadRes.data.id}` });
            } catch (ytErr) {
                console.error(`[${jobId} YouTube 失敗]:`, ytErr);
                updateJob(jobId, { status: 'error', error: 'YouTube 上傳失敗：' + (ytErr.message || '授權失效') });
            } finally {
                cleanupAudio(audioFile.path);
                next(); // 完成後觸發下一個佇列任務
            }
        })
        .on('error', (err) => {
            console.error(`[${jobId} FFmpeg 錯誤]:`, err);
            updateJob(jobId, { status: 'error', error: '轉碼失敗：' + err.message });
            cleanupAudio(audioFile.path);
            next();
        })
        .pipe(videoStream, { end: true });
}

function cleanupAudio(audioPath) {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
