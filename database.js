// database.js
const Database = require('better-sqlite3');

// study.db 파일을 사용
const db = new Database('study.db');

// 공부 세션을 저장할 테이블 생성
db.prepare(`
    CREATE TABLE IF NOT EXISTS study_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        duration_seconds INTEGER
    )
`).run();
// 공부 세션을 시작할 때 호출되는 함수
module.exports = db;