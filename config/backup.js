const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

// බැකප් එක සේව් විය යුතු ස්ථානය (Backend එක ඇතුලේ 'backups' කියා ෆෝල්ඩරයක් සෑදේ)
const BACKUP_DIR = path.join(__dirname, '../backups');

// ෆෝල්ඩරය නැත්නම් එය අලුතින් සෑදීම
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function runBackup() {
    const date = new Date();
    // බැකප් ෆයිල් එකට අද දිනය සහ වේලාව නම විදිහට දීම (उदा: backup_2026-06-09)
    const fileName = `backup_${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const backupPath = path.join(BACKUP_DIR, fileName);

    // MongoDB Atlas හෝ local DB එක mongodump හරහා බැකප් කිරීමේ Command එක
    // සටහන: Local MongoDB සඳහා standard URI එක පාවිච්චි වේ
    const dbUri = process.env.MONGO_URI || "mongodb://localhost:27017/grocery_pos"; 
    const cmd = `mongodump --uri="${dbUri}" --out="${backupPath}"`;

    console.log("⏳ ස්වයංක්‍රීය Database Backup ක්‍රියාවලිය ආරම්භ වුණා...");

    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ බැකප් කිරීම අසාර්ථකයි: ${error.message}`);
            return;
        }
        console.log(`🎉 Database එක සාර්ථකව බැකප් කලා! ස්ථානය: ${backupPath}`);
    });
}

// ⏰ AUTOMATION SCHEDULE (CRON JOB)
// මේකෙන් හැමදාම රෑ 11:59 ට (කඩේ වහන වෙලාවට) ඔටෝමැටිකව බැකප් එක රන් වෙනවා.
cron.schedule('59 23 * * *', () => {
    runBackup();
});

// ටෙස්ට් කරලා බලන්න ඕන නම් පහල තියෙන කෝඩ් එකෙන් හැම පැයකටම වරක් බැකප් එකක් සිදුවේ:
// cron.schedule('0 * * * *', () => { runBackup(); });

module.exports = { runBackup };