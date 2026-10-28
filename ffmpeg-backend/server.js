const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(cors());

// 確保 uploads 暫存資料夾存在
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 安全純英文暫存檔名，避免中文亂碼導致 FFmpeg 時間軸卡住
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || (file.fieldname === 'image' ? '.jpg' : '.mp3');
        cb(null, `${file.fieldname}_${Date.now()}${ext}`);
    }
});

const upload = multer({ storage: storage });

app.post('/convert', upload.fields([{ name: 'image' }, { name: 'audio' }]), async (req, res) => {
    // 延長 HTTP 超時時間至 30 分鐘
    req.setTimeout(1800000);
    res.setTimeout(1800000);

    try {
        if (!req.files || !req.files['image'] || !req.files['audio']) {
            return res.status(400).send('缺少圖片或音訊檔案');
        }

        const imageFile = req.files['image'][0];
        const audioFile = req.files['audio'][0];
        const enhanceType = req.body.enhance || 'none';
        const accessToken = req.body.accessToken;
        const ytTitle = req.body.title || 'My Audio Track';
        const ytDescription = req.body.description || 'Uploaded with Web App';
        const ytPrivacy = req.body.privacy || 'private';

        if (!accessToken) {
            return res.status(400).send('未提供 YouTube Access Token，請先連結帳號');
        }

        const outputPath = path.join(uploadDir, `output_${Date.now()}.mp4`);

        console.log(`[開始壓碼] 圖片: ${imageFile.path}, 音檔: ${audioFile.path}, 強化選項: ${enhanceType}`);

        let command = ffmpeg()
            .input(imageFile.path)
            .inputOptions(['-loop 1'])
            .input(audioFile.path)
            .videoCodec('libx264')
            .size('1280x720')
            .fps(1) // 靜態圖片 1 fps 穩定極速
            .outputOptions([
                '-preset ultrafast',
                '-tune stillimage',
                '-pix_fmt yuv420p',
                '-shortest',
                '-threads 0',
                '-movflags +faststart'
            ]);

        // 聲音強化選項
        if (enhanceType === 'none') {
            command.audioCodec('copy'); // 原始音效無損直複製，速度最快
        } else if (enhanceType === 'boost') {
            command.audioCodec('aac').audioBitrate('128k').audioFilters('volume=1.4,highpass=f=80');
        } else if (enhanceType === 'denoise') {
            command.audioCodec('aac').audioBitrate('128k').audioFilters('highpass=f=120,volume=1.3');
        }

        command
            .on('progress', (progress) => {
                if (progress.timemark) {
                    console.log(`[壓碼進度] 已處理時間: ${progress.timemark}`);
                }
            })
            .on('end', async () => {
                console.log('[壓碼成功] 開始由雲端直接推送到 YouTube...');
                
                try {
                    const oauth2Client = new google.auth.OAuth2();
                    oauth2Client.setCredentials({ access_token: accessToken });

                    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

                    const uploadRes = await youtube.videos.insert({
                        part: ['snippet', 'status'],
                        requestBody: {
                            snippet: {
                                title: ytTitle,
                                description: ytDescription,
                                categoryId: '10'
                            },
                            status: {
                                privacyStatus: ytPrivacy
                            }
                        },
                        media: {
                            body: fs.createReadStream(outputPath)
                        }
                    });

                    console.log(`[YouTube 上傳成功] Video ID: ${uploadRes.data.id}`);

                    // 成功完成，將 YouTube 影片資訊回傳給手機前端
                    res.json({
                        success: true,
                        videoId: uploadRes.data.id,
                        videoUrl: `https://youtu.be/${uploadRes.data.id}`
                    });

                } catch (ytErr) {
                    console.error('[YouTube 上傳失敗]:', ytErr);
                    res.status(500).send('YouTube 上傳失敗：' + (ytErr.message || '授權失效或網路中斷'));
                } finally {
                    // 清理暫存檔案
                    if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                    if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                }
            })
            .on('error', (err) => {
                console.error('[FFmpeg 錯誤]:', err);
                if (!res.headersSent) res.status(500).send('轉碼失敗：' + err.message);
                if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            })
            .save(outputPath);

    } catch (err) {
        console.error('[伺服器例外錯誤]:', err);
        if (!res.headersSent) res.status(500).send('伺服器錯誤：' + err.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
