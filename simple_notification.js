// 가장 간단한 알림 시스템 (의존성 없음)
const fs = require('fs');
const path = require('path');

// 알림 로그 디렉토리
const NOTIFICATION_DIR = path.join(__dirname, 'notifications');

// 디렉토리 생성
if (!fs.existsSync(NOTIFICATION_DIR)) {
    fs.mkdirSync(NOTIFICATION_DIR, { recursive: true });
}

// 간단한 알림 함수
function sendSimpleNotification(team, resultData) {
    const currentTime = new Date();
    const formattedTime = currentTime.toLocaleString('ko-KR');
    const timestamp = currentTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    
    // 1. 콘솔 알림 (색상 포함)
    console.log('\n' + '🔔'.repeat(30));
    console.log(`📧 ${team.toUpperCase()} 실행 완료 알림`);
    console.log('🔔'.repeat(30));
    console.log(`⏰ 시간: ${formattedTime}`);
    console.log(`📊 처리건수: ${resultData ? resultData.length : 0}건`);
    console.log(`✅ 상태: 실행 완료`);
    console.log(`📁 백업: Excel 파일 생성됨`);
    console.log('🔔'.repeat(30) + '\n');
    
    // 2. 간단한 텍스트 파일로 로그
    const logContent = `
[${formattedTime}] RPA ADMIN 알림
=============================================
실행 조: ${team.toUpperCase()}
처리 데이터: ${resultData ? resultData.length : 0}건
상태: ✅ 실행 완료
메모: Excel 백업 파일 생성 완료
=============================================
`;
    
    const logFileName = `notification_${team}_${timestamp}.txt`;
    const logFilePath = path.join(NOTIFICATION_DIR, logFileName);
    
    try {
        fs.writeFileSync(logFilePath, logContent.trim(), 'utf8');
        console.log(`📝 알림 로그 저장: ${logFileName}`);
    } catch (error) {
        console.error('로그 저장 실패:', error.message);
    }
    
    // 3. 최신 알림 상태 파일 업데이트 (웹에서 확인용)
    const statusFile = path.join(NOTIFICATION_DIR, 'latest_status.json');
    const status = {
        lastUpdate: formattedTime,
        lastTeam: team.toUpperCase(),
        dataCount: resultData ? resultData.length : 0,
        status: 'completed'
    };
    
    try {
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2), 'utf8');
    } catch (error) {
        console.error('상태 파일 저장 실패:', error.message);
    }
}

module.exports = {
    sendSimpleNotification
};