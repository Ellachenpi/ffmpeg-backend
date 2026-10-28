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

app.post('/convert', upload.fields([{ name: 'image' }, { name: 'audio' }]), (req, res) => {
    try {
        if (!req.files || !req.files['image'] || !req.files['audio']) {
            return res.status(400).send('缺少圖片或音訊檔案');
        }

        const accessToken = req.body.accessToken;
        if (!accessToken) {
            return res.status(400).send('未提供 YouTube Access Token');
        }

        const jobId = `job_${Date.now()}`;
        const imageFile = req.files['image'][0];
        const audioFile = req.files['audio'][0];
        const ytTitle = req.body.title || 'My Audio Track';
        const ytDescription = req.body.description || 'Uploaded with Web App';
        const ytPrivacy = req.body.privacy || 'private';

        updateJob(jobId, { status: 'processing', progress: '00:00:00', videoUrl: null, error: null });

        res.json({ success: true, jobId: jobId });

        runDirectStreamJob(jobId, imageFile, audioFile, accessToken, ytTitle, ytDescription, ytPrivacy);

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

function runDirectStreamJob(jobId, imageFile, audioFile, accessToken, ytTitle, ytDescription, ytPrivacy) {
    console.log(`[直傳任務開始] JobID: ${jobId}`);

    // 使用記憶體 Stream 管道，完全不產出硬碟 MP4 檔！
    const videoStream = new PassThrough();

    // 先異步啟動 YouTube 上傳監聽
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

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
        .size('1280x720')
        .fps(1)
        .outputOptions([
            '-preset ultrafast',
            '-tune stillimage',
            '-pix_fmt yuv420p',
            '-shortest',
            '-threads 1',
            '-f mp4',
            '-movflags frag_keyframe+empty_moov' // 關鍵：讓串流邊壓邊發送，不佔用硬碟
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
            console.log(`[${jobId} FFmpeg 轉碼串流完成] 等待 YouTube 處理...`);
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
