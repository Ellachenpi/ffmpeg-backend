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
        cb(null, `${file.fieldname}_${Date.now()}${ext}`);
    }
});

const upload = multer({ storage: storage });

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

app.post('/convert', upload.fields([{ name: 'image' }, { name: 'audio' }]), (req, res) => {
    try {
        if (!req.files || !req.files['image'] || !req.files['audio']) {
            return res.status(400).send('缺少圖片或音訊檔案');
        }

        const refreshToken = req.body.refreshToken;
        const accessToken = req.body.accessToken;

        if (!refreshToken && !accessToken) {
            return res.status(400).send('未提供有效的 YouTube 授權 Token');
        }

        const jobId = `job_${Date.now()}`;
        const imageFile = req.files['image'][0];
        const audioFile = req.files['audio'][0];
        const ytTitle = req.body.title || 'My Audio Track';
        const ytDescription = req.body.description || 'Uploaded with Web App';
        const ytPrivacy = req.body.privacy || 'private';

        updateJob(jobId, { status: 'processing', progress: '00:00:00', videoUrl: null, error: null });

        res.json({ success: true, jobId: jobId });

        runMemoryControlledJob(jobId, imageFile, audioFile, refreshToken, accessToken, ytTitle, ytDescription, ytPrivacy);

    } catch (err) {
        console.error('[伺服器例外錯誤]:', err);
        if (!res.headersSent) res.status(500).send('伺服器錯誤：' + err.message);
    }
});

app.get('/status/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const jobs = getJobs();
    const job = jobs[jobId];
    if (!job) return res.status(404).json({ error: '找不到該任務' });
    res.json(job);
});

function runMemoryControlledJob(jobId, imageFile, audioFile, refreshToken, accessToken, ytTitle, ytDescription, ytPrivacy) {
    console.log(`[記憶體控管任務開始] JobID: ${jobId}`);

    const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    auth.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken
    });

    // 關鍵修復：限制 Stream 內部緩衝區上限為 1MB (highWaterMark)，防止數據積壓撐爆 512MB RAM
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
        .size('480x270') // 解析度調為 270p，徹底把 CPU 與 RAM 佔用壓到最低！
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
                console.log(`[${jobId} 進度] ${progress.timemark}`);
            }
        })
        .on('end', async () => {
            console.log(`[${jobId} 轉碼完成] 等待 YouTube 發布確認...`);
            updateJob(jobId, { progress: '正在完成 YouTube 發布...' });
            try {
                const uploadRes = await uploadPromise;
                console.log(`[${jobId} YouTube 上傳成功] Video ID: ${uploadRes.data.id}`);
                updateJob(jobId, { status: 'completed', videoUrl: `https://youtu.be/${uploadRes.data.id}` });
            } catch (ytErr) {
                console.error(`[${jobId} YouTube 失敗]:`, ytErr);
                updateJob(jobId, { status: 'error', error: 'YouTube 上傳失敗：' + (ytErr.message || '授權失效') });
            } finally {
                cleanupFiles(imageFile.path, audioFile.path);
            }
        })
        .on('error', (err) => {
            console.error(`[${jobId} FFmpeg 錯誤]:`, err);
            updateJob(jobId, { status: 'error', error: '轉碼失敗：' + err.message });
            cleanupFiles(imageFile.path, audioFile.path);
        })
        .pipe(videoStream, { end: true });
}

function cleanupFiles(img, audio) {
    if (fs.existsSync(img)) fs.unlinkSync(img);
    if (fs.existsSync(audio)) fs.unlinkSync(audio);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
