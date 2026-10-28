const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(cors());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || (file.fieldname === 'image' ? '.jpg' : '.mp3');
        cb(null, `${file.fieldname}_${Date.now()}${ext}`);
    }
});

const upload = multer({ storage: storage });

// 記憶體存放工作狀態 (Job Queue)
const jobs = {};

// 1. 建立非同步處理任務 (按完立即回應，連線秒斷不卡住)
app.post('/convert', upload.fields([{ name: 'image' }, { name: 'audio' }]), (req, res) => {
    try {
        if (!req.files || !req.files['image'] || !req.files['audio']) {
            return res.status(400).send('缺少圖片或音訊檔案');
        }

        const accessToken = req.body.accessToken;
        if (!accessToken) {
            return res.status(400).send('未提供 YouTube Access Token，請先連結帳號');
        }

        const jobId = `job_${Date.now()}`;
        const imageFile = req.files['image'][0];
        const audioFile = req.files['audio'][0];
        const enhanceType = req.body.enhance || 'none';
        const ytTitle = req.body.title || 'My Audio Track';
        const ytDescription = req.body.description || 'Uploaded with Web App';
        const ytPrivacy = req.body.privacy || 'private';

        // 初始化工作狀態
        jobs[jobId] = {
            status: 'processing',
            progress: '00:00:00',
            videoUrl: null,
            error: null,
            createdAt: new Date()
        };

        // 關鍵：立刻回應手機，釋放 HTTP 連線，讓手機可以自由離線！
        res.json({ success: true, jobId: jobId });

        // 背景獨立執行 FFmpeg 與 YouTube 上傳
        runBackgroundJob(jobId, imageFile, audioFile, enhanceType, accessToken, ytTitle, ytDescription, ytPrivacy);

    } catch (err) {
        console.error('[伺服器例外錯誤]:', err);
        if (!res.headersSent) res.status(500).send('伺服器錯誤：' + err.message);
    }
});

// 2. 查詢任務進度 API
app.get('/status/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs[jobId];
    if (!job) {
        return res.status(404).json({ error: '找不到該任務或已清除' });
    }
    res.json(job);
});

// 背景執行邏輯
function runBackgroundJob(jobId, imageFile, audioFile, enhanceType, accessToken, ytTitle, ytDescription, ytPrivacy) {
    const outputPath = path.join(uploadDir, `output_${jobId}.mp4`);
    console.log(`[背景任務開始] JobID: ${jobId}`);

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
            '-threads 0',
            '-movflags +faststart'
        ]);

    if (enhanceType === 'none') {
        command.audioCodec('copy');
    } else if (enhanceType === 'boost') {
        command.audioCodec('aac').audioBitrate('128k').audioFilters('volume=1.4,highpass=f=80');
    } else if (enhanceType === 'denoise') {
        command.audioCodec('aac').audioBitrate('128k').audioFilters('highpass=f=120,volume=1.3');
    }

    command
        .on('progress', (progress) => {
            if (progress.timemark && jobs[jobId]) {
                jobs[jobId].progress = progress.timemark;
                console.log(`[${jobId} 進度] ${progress.timemark}`);
            }
        })
        .on('end', async () => {
            console.log(`[${jobId} 壓碼完成] 開始推送到 YouTube...`);
            if (jobs[jobId]) jobs[jobId].progress = '正在推送到 YouTube...';

            try {
                const oauth2Client = new google.auth.OAuth2();
                oauth2Client.setCredentials({ access_token: accessToken });
                const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

                const uploadRes = await youtube.videos.insert({
                    part: ['snippet', 'status'],
                    requestBody: {
                        snippet: { title: ytTitle, description: ytDescription, categoryId: '10' },
                        status: { privacyStatus: ytPrivacy }
                    },
                    media: { body: fs.createReadStream(outputPath) }
                });

                console.log(`[${jobId} YouTube 上傳成功] Video ID: ${uploadRes.data.id}`);

                if (jobs[jobId]) {
                    jobs[jobId].status = 'completed';
                    jobs[jobId].videoUrl = `https://youtu.be/${uploadRes.data.id}`;
                }
            } catch (ytErr) {
                console.error(`[${jobId} YouTube 失敗]:`, ytErr);
                if (jobs[jobId]) {
                    jobs[jobId].status = 'error';
                    jobs[jobId].error = 'YouTube 上傳失敗：' + (ytErr.message || '授權失效');
                }
            } finally {
                if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            }
        })
        .on('error', (err) => {
            console.error(`[${jobId} FFmpeg 錯誤]:`, err);
            if (jobs[jobId]) {
                jobs[jobId].status = 'error';
                jobs[jobId].error = '轉碼失敗：' + err.message;
            }
            if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
            if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        })
        .save(outputPath);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
