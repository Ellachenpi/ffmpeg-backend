const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// 確保 uploads 暫存資料夾一定存在
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

app.post('/convert', upload.fields([{ name: 'image' }, { name: 'audio' }]), (req, res) => {
    // 延長此請求的 HTTP 超時時間至 10 分鐘，避免大檔案壓碼到一半被斷線
    req.setTimeout(600000);
    res.setTimeout(600000);

    try {
        if (!req.files || !req.files['image'] || !req.files['audio']) {
            return res.status(400).send('缺少圖片或音訊檔案');
        }

        const imageFile = req.files['image'][0];
        const audioFile = req.files['audio'][0];
        const enhanceType = req.body.enhance || 'none';

        const outputPath = path.join(uploadDir, `output_${Date.now()}.mp4`);

        console.log(`[開始壓碼] 圖片: ${imageFile.originalname}, 音檔: ${audioFile.originalname}`);

        let command = ffmpeg()
            .input(imageFile.path)
            .inputOptions(['-loop 1'])
            .input(audioFile.path)
            .videoCodec('libx264')
            .size('1280x720')
            .fps(25)
            .audioCodec('aac')
            .audioBitrate('192k')
            .outputOptions([
                '-preset ultrafast',
                '-tune stillimage',
                '-pix_fmt yuv420p',
                '-shortest',
                '-movflags +faststart'
            ]);

        // 聲音強化選項
        if (enhanceType === 'boost') {
            command.audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80');
        } else if (enhanceType === 'denoise') {
            command.audioFilters('highpass=f=120,volume=1.3');
        }

        command
            .on('progress', (progress) => {
                if (progress.timemark) {
                    console.log(`[壓碼進度] 已處理時間: ${progress.timemark}`);
                }
            })
            .on('end', () => {
                console.log('[壓碼成功] 正在傳送影片回前端...');
                res.download(outputPath, 'output.mp4', () => {
                    // 下載完成後自動清理伺服器暫存
                    if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                    if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                });
            })
            .on('error', (err) => {
                console.error('[FFmpeg 錯誤]:', err);
                res.status(500).send('轉碼失敗：' + err.message);
                if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            })
            .save(outputPath);

    } catch (err) {
        console.error('[伺服器例外錯誤]:', err);
        res.status(500).send('伺服器錯誤：' + err.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
