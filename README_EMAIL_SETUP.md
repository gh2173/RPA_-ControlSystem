# RPA ADMIN 이메일 알림 시스템 설치 가이드

## 폐쇄망 환경에서 nodemailer 설치 방법

### 방법 1: npm pack을 사용한 오프라인 설치 (권장)

#### 1단계: 인터넷 연결된 환경에서 패키지 다운로드
```bash
# nodemailer 패키지 다운로드
npm pack nodemailer

# 결과: nodemailer-7.0.5.tgz 파일 생성
```

#### 2단계: 폐쇄망 서버로 파일 복사
- `nodemailer-7.0.5.tgz` 파일을 폐쇄망 서버의 프로젝트 폴더로 복사

#### 3단계: 폐쇄망에서 설치
```bash
# 프로젝트 폴더에서 실행
chmod +x install_nodemailer_offline.sh
./install_nodemailer_offline.sh
```

또는 수동 설치:
```bash
npm install nodemailer-7.0.5.tgz
```

### 방법 2: 대체 이메일 시스템 사용 (nodemailer 없이)

nodemailer 설치가 불가능한 경우, 대체 시스템을 사용합니다:

1. **자동으로 대체 모드 실행**
   - nodemailer가 없으면 자동으로 대체 시스템 사용
   - 이메일 내용이 로그 파일로 저장됨
   - 콘솔에 상세한 알림 출력

2. **로그 파일 위치**
   ```
   /프로젝트폴더/email_logs/
   ├── email_A-TEAM_2025-08-27T06-19-43.json
   ├── email_A-TEAM_2025-08-27T06-19-43.txt
   └── ...
   ```

3. **로그 조회 API**
   - `GET /getEmailLogs?team=A-TEAM&limit=10`
   - 저장된 이메일 로그 조회 가능

## 이메일 시스템 기능

### 1. 자동 알림
- A조: 07:30 실행 후 알림
- B조: 15:30 실행 후 알림  
- C조: 23:30 실행 후 알림

### 2. 수신자 관리 API
```javascript
// 수신자 목록 조회
GET /getEmailRecipients

// 수신자 추가
POST /addEmailRecipient
{
  "email": "new@example.com"
}

// 수신자 삭제
POST /removeEmailRecipient
{
  "email": "remove@example.com"
}
```

### 3. 테스트 이메일
```javascript
POST /sendTestEmail
```

## 설정 정보

### 이메일 서버 설정
```javascript
const emailConfig = {
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    auth: {
        user: 'lgh0820@nepes.co.kr',
        pass: 'Spvotm@0820'
    }
};
```

### 기본 수신자
```javascript
const emailRecipients = {
    fixed: ['lgh0820@nepes.co.kr'],    // 고정 수신자
    additional: []                      // 추가 수신자 (API로 관리)
};
```

## 문제 해결

### 1. nodemailer 설치 실패시
- 대체 시스템이 자동으로 활성화됨
- 콘솔에 "⚠️ nodemailer 로드 실패, 대체 이메일 시스템 사용" 메시지 출력

### 2. Oracle Client 오류로 서버 시작 실패시
```bash
# Oracle Client 설치 또는 설정 필요
# 또는 해당 부분을 주석 처리 후 테스트
```

### 3. 로그 확인
- 콘솔에서 이메일 전송 상태 확인
- `email_logs/` 폴더의 파일로 내용 확인

## 실행 확인

### 1. 서버 시작
```bash
npm start
# 또는
node --no-deprecation server.js
```

### 2. 콘솔 출력 확인
```
✅ nodemailer 로드 성공
# 또는
⚠️ nodemailer 로드 실패, 대체 이메일 시스템 사용
```

### 3. 테스트 실행
- 프로젝트 폴더의 `test_fallback.js` 실행
- API `/sendTestEmail` 호출

## 보안 권장사항

1. **비밀번호 관리**
   - production 환경에서는 환경변수 사용 권장
   - `process.env.EMAIL_PASSWORD` 등으로 변경

2. **수신자 제한**
   - 필요한 수신자만 추가
   - 정기적인 수신자 목록 검토

3. **로그 파일 관리**
   - 주기적인 로그 파일 정리
   - 민감 정보 포함 여부 확인