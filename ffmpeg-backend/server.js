const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// 設定檔案暫存區
const upload = multer({ dest: 'uploads/' });

app.post('/convert', upload.fields([{ name: 'image' }, { name: 'audio' }]), (req, res) => {
    try {
        if (!req.files || !req.files['image'] || !req.files['audio']) {
            return res.status(400).send('缺少圖片或音訊檔案');
        }

        const imageFile = req.files['image'][0];
        const audioFile = req.files['audio'][0];
        const enhanceType = req.body.enhance || 'none';

        const outputPath = path.join(__dirname, 'uploads', `output_${Date.now()}.mp4`);

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
            .on('end', () => {
                // 轉碼成功，回傳影片並刪除暫存檔
                res.download(outputPath, 'output.mp4', () => {
                    if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                    if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                });
            })
            .on('error', (err) => {
                console.error('FFmpeg Error:', err);
                res.status(500).send('轉碼失敗：' + err.message);
                if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            })
            .save(outputPath);

    } catch (err) {
        console.error('Server Error:', err);
        res.status(500).send('伺服器錯誤：' + err.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
