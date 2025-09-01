// 폐쇄망 환경에서 사용할 이메일 대체 모듈
const fs = require('fs');
const path = require('path');

// 이메일 로그 디렉토리
const EMAIL_LOG_DIR = path.join(__dirname, 'email_logs');

// 로그 디렉토리 생성
if (!fs.existsSync(EMAIL_LOG_DIR)) {
    fs.mkdirSync(EMAIL_LOG_DIR, { recursive: true });
}

// 이메일 대체 함수 (파일 로그 + 콘솔 출력)
function sendEmailFallback(team, resultData, emailConfig, emailRecipients) {
    try {
        const currentTime = new Date();
        const formattedTime = currentTime.toLocaleString('ko-KR');
        const timestamp = currentTime.toISOString().replace(/[:.]/g, '-');
        
        // 전체 수신자 목록
        const allRecipients = [...emailRecipients.fixed, ...emailRecipients.additional];
        
        // 이메일 내용 생성
        const emailData = {
            timestamp: formattedTime,
            team: team.toUpperCase(),
            recipients: allRecipients,
            dataCount: resultData ? resultData.length : 0,
            subject: `[RPA ADMIN] ${team.toUpperCase()} 실행 완료 알림 - ${formattedTime}`,
            status: '실행 완료',
            message: 'Excel 백업 파일이 생성되었습니다.'
        };
        
        // 1. 콘솔 로그
        console.log('\n' + '='.repeat(60));
        console.log('📧 이메일 알림 (폐쇄망 모드)');
        console.log('='.repeat(60));
        console.log(`제목: ${emailData.subject}`);
        console.log(`수신자: ${allRecipients.join(', ')}`);
        console.log(`실행 조: ${emailData.team}`);
        console.log(`실행 시간: ${emailData.timestamp}`);
        console.log(`처리 데이터: ${emailData.dataCount}건`);
        console.log(`상태: ${emailData.status}`);
        console.log(`메시지: ${emailData.message}`);
        console.log('='.repeat(60) + '\n');
        
        // 2. JSON 파일로 로그 저장
        const logFileName = `email_${team}_${timestamp}.json`;
        const logFilePath = path.join(EMAIL_LOG_DIR, logFileName);
        
        fs.writeFileSync(logFilePath, JSON.stringify(emailData, null, 2), 'utf8');
        console.log(`📄 이메일 로그 저장: ${logFilePath}`);
        
        // 3. 간단한 텍스트 로그도 생성
        const textLog = `
[${emailData.timestamp}] RPA ADMIN 시스템 알림
=========================================
실행 조: ${emailData.team}
수신자: ${allRecipients.join(', ')}
처리 데이터: ${emailData.dataCount}건
상태: ${emailData.status}
메시지: ${emailData.message}
=========================================
        `.trim();
        
        const textLogFileName = `email_${team}_${timestamp}.txt`;
        const textLogFilePath = path.join(EMAIL_LOG_DIR, textLogFileName);
        
        fs.writeFileSync(textLogFilePath, textLog, 'utf8');
        console.log(`📄 텍스트 로그 저장: ${textLogFilePath}`);
        
        return {
            success: true,
            message: '이메일 알림이 로그로 저장되었습니다',
            logFile: logFilePath,
            textFile: textLogFilePath
        };
        
    } catch (error) {
        console.error('이메일 대체 처리 실패:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// 이메일 로그 조회 함수
function getEmailLogs(team = null, limit = 10) {
    try {
        if (!fs.existsSync(EMAIL_LOG_DIR)) {
            return [];
        }
        
        const files = fs.readdirSync(EMAIL_LOG_DIR)
            .filter(file => file.endsWith('.json'))
            .filter(file => team ? file.includes(team) : true)
            .sort((a, b) => b.localeCompare(a)) // 최신순 정렬
            .slice(0, limit);
        
        const logs = files.map(file => {
            try {
                const filePath = path.join(EMAIL_LOG_DIR, file);
                const content = fs.readFileSync(filePath, 'utf8');
                return JSON.parse(content);
            } catch (error) {
                console.error(`로그 파일 읽기 실패: ${file}`, error);
                return null;
            }
        }).filter(log => log !== null);
        
        return logs;
    } catch (error) {
        console.error('이메일 로그 조회 실패:', error);
        return [];
    }
}

module.exports = {
    sendEmailFallback,
    getEmailLogs
};