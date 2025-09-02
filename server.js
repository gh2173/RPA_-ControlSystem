const express = require('express');
const ExcelJS = require("exceljs");
const app = express();
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('canvas');
const bodyParser = require('body-parser');
const oracledb = require('oracledb');
const ftp = require('basic-ftp');
const session = require('express-session');
const XLSX = require('xlsx');
const puppeteer = require("puppeteer");
// const cron = require('node-cron'); // 폐쇄망 환경에서 제거

oracledb.initOracleClient();

//  테스트 즁

// 정적 파일 제공 설정 및 캐시 제어
app.use('/public', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}, express.static(path.join(__dirname, 'public')));

app.use('/tailwindcss', express.static(path.join(__dirname, 'tailwindcss')));


// const cacheControl = (req, res, next) => {
//     res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
//     res.setHeader('Pragma', 'no-cache');
//     res.setHeader('Expires', '0');
//     next();
// };

// app.use('/public', cacheControl);
// app.use('/public', express.static(path.join(__dirname, 'public')));

// app.use('/public', cacheControl, express.static(path.join(__dirname, 'public')));

const dbConfig1 = {
    user: 'RPA',
    password: 'rpa01!',
    connectString: '192.168.223.13:1521/ERPSIMAX'
};

// 캠퍼스별 장비 매핑 캐시
let campusEquipmentMapping = {
    'NS2': new Set(),
    'NS3': new Set()
};

// Autobe Check 조별 데이터 캐시 시스템
let autobeDataCache = {
    'a-team': { data: [], lastUpdate: null },
    'b-team': { data: [], lastUpdate: null },
    'c-team': { data: [], lastUpdate: null }
};

//test진행_1
// 조별 시간 설정
const teamSchedules = {
    'a-team': { hour: 7, minute: 30, timeFilterStart: '07:00:00', timeFilterEnd: '07:30:00' },  // 07:30에 실행, 07:00~07:30 범위 데이터
    'b-team': { hour: 15, minute: 30, timeFilterStart: '15:00:00', timeFilterEnd: '15:30:00' }, // 15:30에 실행, 15:00~15:30 범위 데이터
    'c-team': { hour: 23, minute: 30, timeFilterStart: '23:00:00', timeFilterEnd: '23:30:00' }  // 23:30에 실행, 23:00~23:30 범위 데이터
};

// 캠퍼스별 장비 매핑 로드 함수
async function loadCampusEquipmentMapping() {
    let connection;
    try {
        console.log('캠퍼스별 장비 매핑 정보 로딩 시작...');
        
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            select *
            from (
               select
                   EQUIPMENT_ID     as EQ_ID,
                   EQUIPMENT_GROUP  as EQ_GROUP,
                   PLANT            as EQ_PLANT,
                   EQUIPMENT_OWNER  as EQ_OWNER,
                   case
                       /* ── T2000만 모델(=장비ID) 단위로 분기 ── */
                       when EQUIPMENT_GROUP = 'T2000'
                        and EQUIPMENT_ID in (
                             'T2K75','T2K76','T2K85','T2K93','T2K94','T2K95','T2K98','T2K99',
                             'T2K100','T2K101','T2K102','T2K103','T2K104','T2K105','T2K106'
                        ) then 'NS3'
                       when EQUIPMENT_GROUP = 'T2000'
                        and EQUIPMENT_ID not in (
                             'T2K75','T2K76','T2K85','T2K93','T2K94','T2K95','T2K98','T2K99',
                             'T2K100','T2K101','T2K102','T2K103','T2K104','T2K105','T2K106'
                        ) then 'NS2'
                       /* ── T2000 이외: 각 CAMPUS별 그룹 고정 매핑 ── */
                       when EQUIPMENT_GROUP in (
                           /* NS2에 속하는 다른 그룹들 */ 'ETS600','U-Flex'
                       ) then 'NS2'
                       when EQUIPMENT_GROUP in (
                           /* NS3에 속하는 다른 그룹들 */ 'U-FLEX-XD','U-FLEX-PLUS','V93000', 'T6391', 'DIAMONDX'
                       ) then 'NS3'
                       else null
                   end as CAMPUS
               from RPA_ADMIN.view_equipment
               where EQUIPMENT_OWNER like '%TEST%'
                 and PLANT in ('CCUBEDIGITAL')
            ) v
            where v.CAMPUS is not null
            order by v.EQ_ID asc
        `);
        
        // 캐시 초기화
        campusEquipmentMapping.NS2.clear();
        campusEquipmentMapping.NS3.clear();
        
        // 결과를 캐시에 저장
        result.rows.forEach(row => {
            const equipmentId = row[0]; // EQ_ID
            const campus = row[4]; // CAMPUS
            
            campusEquipmentMapping[campus].add(equipmentId);
        });
        
        console.log(`캠퍼스별 장비 매핑 로딩 완료:`);
        console.log(`- NS2: ${campusEquipmentMapping.NS2.size}개 장비`);
        console.log(`- NS3: ${campusEquipmentMapping.NS3.size}개 장비`);
        
    } catch (error) {
        console.error('캠퍼스 매핑 로드 실패:', error);
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('DB 연결 종료 중 오류:', err);
            }
        }
    }
}

// 장비 ID로 캠퍼스 판단 함수
function getEquipmentCampus(equipmentId) {
    if (campusEquipmentMapping.NS2.has(equipmentId)) {
        return 'NS2';
    } else if (campusEquipmentMapping.NS3.has(equipmentId)) {
        return 'NS3';
    }
    return null; // 매핑되지 않은 장비
}

async function downloadFileFromFTP(remotePath, localPath) {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });
        await client.downloadTo(localPath, remotePath);
    } catch (error) {
        console.error('FTP download error:', error);
        throw error;
    }
    client.close();
}

// async function fetchImagesFromFTP(lotId) {
//     const client = new ftp.Client();
//     client.ftp.verbose = true;
//     try {
//         await client.access({
//             host: "192.168.223.23",
//             user: "hyperauto",
//             password: "Gkdlvj123!@#",
//             secure: false
//         });

//         const basePath = `RPA/probemark_Image/CONVERSION/${lotId}/`;
//         const folders = await client.list(basePath);
//         if (folders.length === 0) {
//             throw new Error('No folders found');
//         }
//         const latestFolder = folders.sort((a, b) => b.name.localeCompare(a.name))[0].name;
//         const lotPath = `${basePath}${latestFolder}/`;

//         const subFolders = await client.list(lotPath);
//         if (subFolders.length === 0) {
//             throw new Error('No subfolders found');
//         }
//         const latestSubFolder = subFolders.sort((a, b) => b.name.localeCompare(a.name))[0].name;
//         const imagePath = `${lotPath}${latestSubFolder}/`;

//         const files = await client.list(imagePath);
//         //const bmpFiles = files.filter(file => file.name.endsWith('.bmp'));
//         const bmpFiles = files.filter(file => file.name.endsWith('.bmp') || file.name.endsWith('.jpg'));

//         return bmpFiles.map(file => ({
//             name: file.name,
//             path: `ftp://192.168.223.23${imagePath}${file.name}`
//         }));
//     } catch (error) {
//         console.error('FTP fetch error:', error);
//         throw error;
//     } finally {
//         client.close();
//     }
// }

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        httpOnly: true,
        maxAge: 3600000
    }
}));

app.listen(5000, '0.0.0.0', function () {
    console.log('Server is running on http://<server-ip>:5000');
    
    // Autobe Check 스케줄러 초기화
    setupSchedulers();
    
    // 캠퍼스별 장비 매핑 로드
    console.log('캠퍼스별 장비 매핑 로드 시작...');
    loadCampusEquipmentMapping().catch(err => console.error('캠퍼스 매핑 로드 실패:', err));
    
    // 서버 시작 후 초기 데이터 로드 (선택사항)
    console.log('서버 시작 후 초기 데이터 로드 시작...');
    // updateTeamData('a-team').catch(err => console.error('A조 초기 로드 실패:', err));
    // updateTeamData('b-team').catch(err => console.error('B조 초기 로드 실패:', err));
    // updateTeamData('c-team').catch(err => console.error('C조 초기 로드 실패:', err));
});

function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    } else {
        res.redirect('/login_RPA');
    }
}

app.get('/login_RPA', function (req, res) {
    res.sendFile(path.join(__dirname, 'RPA_login.html'));
});

app.get('/login', async function (req, res) {
    const { userId, password, campus } = req.query;

    console.log('Login request received:', { userId, password, campus });

    const query = `
        SELECT USER_ID, USER_NAME, GW_DEPT_NAME, GW_USER_POSITION,
               'nepes_' || SUBSTR(user_id, -4) AS USER_PW
        FROM (
            SELECT a.*, 
                   ROW_NUMBER() OVER (PARTITION BY a.USER_ID, a.USER_NAME ORDER BY a.GW_IF_TIME DESC) AS rn
            FROM RPA_ADMIN.view_userinfo a
        ) tmp
        WHERE rn = 1
          --AND EMAIL IS NOT NULL
          AND GW_DEPT_NAME in ('제조1파트','제조2파트','하이퍼오토메이션팀')
          AND GW_USER_POSITION NOT LIKE 'S%'
          AND USER_ID = :userId
    `;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(query, [userId]);
        await connection.close();

        console.log('Database query result:', result);

        if (result.rows.length === 0) {
            res.json({ success: false, message: '계정 정보가 없습니다. 관리자에게 문의하세요.' });
        } else {
            const dbUserPw = result.rows[0][4];
            const userName = result.rows[0][1];
            console.log('Generated USER_PW:', dbUserPw);
            if (dbUserPw === password) {
                req.session.userId = userId;
                req.session.userName = userName; // USER_NAME을 세션에 저장
                req.session.campus = campus; // 캠퍼스 정보를 세션에 저장
                console.log('Session saved:', { userId, userName, campus });
                res.json({ success: true });
            } else {
                res.json({ success: false, message: 'PASSWORD를 확인해주세요.' });
            }
        }
    } catch (error) {
        console.error('Database error:', error.message);
        res.status(500).json({ success: false, message: `Database error: ${error.message}` });
    }
});


// 사용자 정보를 반환하는 API 엔드포인트 추가
app.get('/user_info', function (req, res) {
    if (req.session.userName) {
        res.json({ 
            userName: req.session.userName,
            campus: req.session.campus || null
        });
    } else {
        res.status(401).json({ message: '로그인 필요' });
    }
});

app.post('/logout', function(req, res) {
    req.session.destroy(function(err) {
        if(err) {
            console.error('세션 삭제 중 오류 발생:', err);
            res.status(500).json({ success: false, message: '로그아웃 실패' });
        } else {
            res.clearCookie('connect.sid');
            res.json({ success: true, message: '로그아웃 성공' });
        }
    });
});

app.use('/Ark_RPA_Control_system', isAuthenticated);

app.get('/Ark_RPA_Control_system', function (req, res) {
    res.sendFile(path.join(__dirname, 'RPA_index.html'));
});

// Report.html 파일을 제공하는 엔드포인트 추가
app.get('/report', function (req, res) {
    res.sendFile(path.join(__dirname, 'Report.html'));
});


app.get('/getSummaryReport', async function (req, res) {
    let connection;
    try {
        // 세션에서 캠퍼스 정보 가져오기
        const campus = req.session.campus;
        console.log('Summary report request for campus:', campus);
        
        // Oracle DB 연결
        connection = await oracledb.getConnection(dbConfig1);
        
        // 결과를 객체로 변환하도록 설정
        const originalOutFormat = oracledb.outFormat;
        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

        // 데이터베이스에서 요약 보고서 데이터 조회
        const result = await connection.execute(`
            SELECT ID,
                   START_TIME,
                   END_TIME,
                   RUN_TIME,
                   SORT_TYPE,
                   MACHINE,
                   LOT_ID,
                   SLOT,
                   STEP,
                   DEVICE_PPID,
                   TOP_POSITION,
                   CENTER_POSITION,
                   BOTTOM_POSITION,
                   LEFT_POSITION,
                   RIGHT_POSITION,
                   SETUP_DIE,
                   OD_VALUE,
                   FIRST_DIE_XY,
                   WAFER_LOADING_POS_X,
                   WAFER_LOADING_POS_Y,
                   WAFER_LOADING_POS_Z,
                   POLYGON_TYPE,
                   VERTEX_LENGTH,
                   SANDING_COUNT,
                   SANDING_OD,
                   PROBE_CARD_DEPTH,
                   WAFER_ALIGN_VALUE_X,
                   WAFER_ALIGN_VALUE_Y,
                   PIN_ALIGN_VALUE_Z,
                   WAFER_SETUP_FLATNESS,
                   CREATED_DATE
            
            FROM RPA_ADMIN.summareport
            ORDER BY ID ASC
        `);

        // 원래 형식으로 복원
        oracledb.outFormat = originalOutFormat;
        
        if (!result.rows || result.rows.length === 0) {
            return res.status(404).send('데이터가 없습니다.');
        }

        // 캠퍼스 필터링 적용 (임시로 비활성화)
        let filteredData = result.rows;
        
        if (campus) {
            // 세션 캠퍼스를 실제 캠퍼스로 변환 (ns2CAM -> NS2, ns3CAM -> NS3)
            const targetCampus = campus === 'ns2CAM' ? 'NS2' : campus === 'ns3CAM' ? 'NS3' : campus;
            
            // 임시로 필터링 비활성화 (모든 데이터 통과)
            // filteredData = result.rows.filter(item => {
            //     const equipmentCampus = getEquipmentCampus(item.MACHINE);
            //     return equipmentCampus === targetCampus;
            // });
            
            console.log(`Summary report (filtering disabled): ${result.rows.length} records for campus ${targetCampus}`);
        }

        // 필터링된 데이터를 JSON 형식으로 반환
        res.json(filteredData);

    } catch (error) {
        console.error('Oracle DB에서 데이터를 가져오는 중 오류 발생:', error);
        res.status(500).send('데이터베이스 조회 중 오류가 발생했습니다.');
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('DB 연결 종료 중 오류:', err);
            }
        }
    }
});

app.get('/getImage', function (req, res) {
    const filePath = path.join(__dirname, 'nepesark_2-removebg-preview.png');
    fs.readFile(filePath, function (err, data) {
        if (err) {
            console.error('File read error:', err);
            res.status(500).send('파일을 읽는 중 오류가 발생했습니다.');
        } else {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', 'inline; filename=nepesark_2-removebg-preview.png');
            res.send(data);
        }
    });
});

app.get('/getImage2', function (req, res) {
    const filePath = path.join(__dirname, 'RPA_image.jpg');
    fs.readFile(filePath, function (err, data) {
        if (err) {
            console.error('File read error:', err);
            res.status(500).send('파일을 읽는 중 오류가 발생했습니다.');
        } else {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Content-Disposition', 'inline; filename=nepesark_2.jpg');
            res.send(data);
        }
    });
});


async function getDataFromDB1(campus = null) {
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            SELECT 
                i.STATUS,
                i.EQPID,
                i.DEVICE,
                i.LOT_ID,
                i.STEP_ID,
                i.PC_ID,
                i.PB_ID,
                i.USER_ID,
                TO_CHAR(r.START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS DATE_,
                i.IP,
                ROWNUM,
                r.RPA_STATUS,
                r.PROGRESS,
                r.PG_DETAIL,
                r.FINALLY,
                r.ERROR_ME,
                r.ACTION_SORT,
                r.ACTION_COMMENT,
                r.USERID
            FROM 
                (SELECT 
                    STATUS, EQPID, DEVICE, LOT_ID, STEP_ID, PC_ID, PB_ID, USER_ID, DATE_, IP,
                    ROW_NUMBER() OVER (PARTITION BY EQPID ORDER BY DATE_ DESC) AS rn
                FROM RPA_ADMIN.INTERFACE) i
            LEFT JOIN 
                (SELECT 
                    EQP_ID, SORT_STATUS, LOT_ID, RPA_STATUS, PROGRESS, PG_DETAIL, FINALLY, USERID, START_TIME,ERROR_ME,ACTION_SORT,ACTION_COMMENT,
                    ROW_NUMBER() OVER (PARTITION BY EQP_ID ORDER BY START_TIME DESC) AS rn
                FROM RPA_ADMIN.RPA) r
            ON i.EQPID = r.EQP_ID 
            AND i.STATUS = r.SORT_STATUS 
            AND i.LOT_ID = r.LOT_ID
            WHERE i.rn = 1 AND r.rn = 1 AND r.FINALLY NOT IN ('Ok', 'No')
            ORDER BY i.EQPID ASC
        `);
        
        // 모든 데이터를 먼저 매핑
        const allData = result.rows.map(row => ({
            STATUS: row[0],
            EQPID: row[1],
            DEVICE: row[2],
            LOT_ID: row[3],
            STEP_ID: row[4],
            PC_ID: row[5],
            PB_ID: row[6],
            USER_ID: row[7],
            DATE_: row[8],
            IP: row[9],
            ROWNUM: row[10],
            RPA_STATUS: row[11],
            PROGRESS: row[12],
            PG_DETAIL: row[13],
            FINALLY: row[14], // FINALLY 컬럼 추가
            ACTION_SORT: row[15],
            ACTION_COMMENT: row[16],
            USERID: row[17]
        }));
        
        // 캠퍼스 필터링 (로그인 시 세션 캠퍼스와 매핑)
        if (campus) {
            // 세션 캠퍼스를 실제 캠퍼스로 변환 (ns2CAM -> NS2, ns3CAM -> NS3)
            const targetCampus = campus === 'ns2CAM' ? 'NS2' : campus === 'ns3CAM' ? 'NS3' : campus;
            
            return allData.filter(item => {
                const equipmentCampus = getEquipmentCampus(item.EQPID);
                return equipmentCampus === targetCampus;
            });
        }
        
        return allData;
    } catch (err) {
        console.error(err);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error(err);
            }
        }
    }
}

async function getWaitDataFromDB1(campus = null) {
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            SELECT 
                i.STATUS,
                i.EQPID,
                i.DEVICE,
                i.LOT_ID,
                i.STEP_ID,
                i.PC_ID,
                i.PB_ID,
                i.USER_ID,
                TO_CHAR(r.START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS DATE_,
                i.IP,
                ROWNUM,
                r.RPA_STATUS,
                r.PROGRESS,
                r.PG_DETAIL,
                r.FINALLY,
                r.ACTION_SORT,
                r.ACTION_COMMENT,
                r.USERID
            FROM 
                (SELECT 
                    STATUS, EQPID, DEVICE, LOT_ID, STEP_ID, PC_ID, PB_ID, USER_ID, DATE_, IP,
                    ROW_NUMBER() OVER (PARTITION BY EQPID ORDER BY DATE_ DESC) AS rn
                FROM RPA_ADMIN.INTERFACE) i
            LEFT JOIN 
                (SELECT 
                    EQP_ID, SORT_STATUS, LOT_ID, RPA_STATUS, PROGRESS, PG_DETAIL, FINALLY, USERID, START_TIME, ACTION_SORT,, ACTION_COMMENT,
                    ROW_NUMBER() OVER (PARTITION BY EQP_ID ORDER BY START_TIME DESC) AS rn
                FROM RPA_ADMIN.RPA) r
            ON i.EQPID = r.EQP_ID 
            AND i.STATUS = r.SORT_STATUS 
            --AND i.LOT_ID = r.LOT_ID
            WHERE i.rn = 1 AND r.rn = 1 AND r.FINALLY NOT IN ('Ok', 'No')
            ORDER BY i.EQPID ASC
        `);
        
        // 모든 데이터를 먼저 매핑
        const allData = result.rows.map(row => ({
            STATUS: row[0],
            EQPID: row[1],
            DEVICE: row[2],
            LOT_ID: row[3],
            STEP_ID: row[4],
            PC_ID: row[5],
            PB_ID: row[6],
            USER_ID: row[7],
            DATE_: row[8],
            IP: row[9],
            ROWNUM: row[10],
            RPA_STATUS: row[11],
            PROGRESS: row[12],
            PG_DETAIL: row[13],
            FINALLY: row[14], // FINALLY 컬럼 추가
            ACTION_SORT: row[15],
            ACTION_COMMENT: row[16],
            USERID: row[17]
        }));
        
        // 캠퍼스 필터링 (로그인 시 세션 캠퍼스와 매핑)
        if (campus) {
            // 세션 캠퍼스를 실제 캠퍼스로 변환 (ns2CAM -> NS2, ns3CAM -> NS3)
            const targetCampus = campus === 'ns2CAM' ? 'NS2' : campus === 'ns3CAM' ? 'NS3' : campus;
            
            return allData.filter(item => {
                const equipmentCampus = getEquipmentCampus(item.EQPID);
                return equipmentCampus === targetCampus;
            });
        }
        
        return allData;
    } catch (err) {
        console.error(err);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error(err);
            }
        }
    }
}

app.get('/getMonitoringData', async function (req, res) {
    try {
        const campus = req.session.campus; // 세션에서 캠퍼스 정보 가져오기
        console.log('Monitoring data request for campus:', campus);
        const data = await getDataFromDB1(campus);
        res.json(data);
    } catch (err) {
        res.status(500).send('Error fetching data');
    }
});

app.get('/getWaitData', async function (req, res) {
    try {
        const campus = req.session.campus; // 세션에서 캠퍼스 정보 가져오기
        console.log('Wait data request for campus:', campus);
        const data = await getWaitDataFromDB1(campus);
        res.json(data);
    } catch (err) {
        res.status(500).send('Error fetching data');
    }
});

// Autobe 백업 엑셀 분석 API
app.get('/analyzeAutobeBackup', async function (req, res) {
    try {
        // 현재 시간을 기준으로 해당 팀 판단
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        
        let currentTeam;
        if ((currentHour === 7 && currentMinute >= 0) || (currentHour === 8 && currentMinute < 30)) {
            currentTeam = 'A-TEAM';
        } else if ((currentHour === 15 && currentMinute >= 0) || (currentHour === 16 && currentMinute < 30)) {
            currentTeam = 'B-TEAM';
        } else if ((currentHour === 23 && currentMinute >= 0) || (currentHour === 0 && currentMinute < 30)) {
            currentTeam = 'C-TEAM';
        } else {
            // 시간대가 아닌 경우 가장 최근 팀 찾기
            if (currentHour < 7 || (currentHour === 0 && currentMinute < 30)) {
                currentTeam = 'C-TEAM'; // 새벽이면 전날 c-team
            } else if (currentHour < 15) {
                currentTeam = 'A-TEAM';
            } else {
                currentTeam = 'B-TEAM';
            }
        }

        // FTP 연결
        const client = new ftp.Client();
        client.ftp.verbose = true;
        client.ftp.pasv = true;
        
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        // 백업 경로 설정 (오늘 날짜)
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const backupPath = `RPA/Autobe_Backup/${year}/${month}/${day}/`;

        console.log(`Analyzing team: ${currentTeam}, path: ${backupPath}`);

        // 해당 경로의 파일 목록 가져오기
        const files = await client.list(backupPath);
        console.log('All files in directory:', files.map(f => f.name));
        
        // 해당 팀의 엑셀 파일 찾기
        const teamFiles = files
            .filter(file => file.type !== 2) // 디렉토리 제외
            .filter(file => file.name.includes(`_${currentTeam}_`) && file.name.endsWith('.xlsx'))
            .sort((a, b) => {
                // 파일명에서 타임스탬프 추출하여 정렬 (예: Autobe_A-TEAM_20250829_1324.xlsx)
                const timestampA = a.name.match(/(\d{8}_\d{4})/)?.[1] || '00000000_0000';
                const timestampB = b.name.match(/(\d{8}_\d{4})/)?.[1] || '00000000_0000';
                console.log(`Comparing: ${a.name} (${timestampA}) vs ${b.name} (${timestampB})`);
                return timestampB.localeCompare(timestampA); // 최신순 정렬
            });

        console.log(`Filtered ${currentTeam} files:`, teamFiles.map(f => f.name));

        if (teamFiles.length === 0) {
            client.close();
            return res.status(404).json({ 
                error: `${currentTeam} 팀의 백업 파일을 찾을 수 없습니다.`,
                team: currentTeam 
            });
        }

        // 가장 최신 파일 선택
        const latestFile = teamFiles[0];
        const remotePath = backupPath + latestFile.name;
        const localPath = path.join(__dirname, 'temp_autobe_analyze.xlsx');

        console.log(`Selected latest file: ${latestFile.name}`);

        // FTP에서 파일 다운로드
        await client.downloadTo(localPath, remotePath);
        client.close();

        // 엑셀 파일 읽기
        const workbook = XLSX.readFile(localPath);
        
        // 세 번째 시트 (조인결과) 읽기
        const sheetNames = workbook.SheetNames;
        console.log('Available sheets:', sheetNames);
        
        if (sheetNames.length < 3) {
            // 임시 파일 삭제
            if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
            }
            return res.status(400).json({ error: '세 번째 시트가 존재하지 않습니다.' });
        }

        const thirdSheet = workbook.Sheets[sheetNames[2]]; // 세 번째 시트
        const data = XLSX.utils.sheet_to_json(thirdSheet);

        console.log(`Data rows found: ${data.length}`);

        // 데이터 분석 (확인된 항목 제외)
        let normalCount = 0;
        let abnormalCount = 0;
        let normalEquipments = [];
        let abnormalEquipments = [];

        data.forEach(row => {
            // '확인' 컬럼이 'check'인 경우 제외
            const checkStatus = row['확인'] || '';
            if (checkStatus === 'check') {
                return; // 이미 확인된 항목은 건너뜀
            }

            if (row['상태'] === '정상') {
                normalCount++;
                if (row['장비ID']) {
                    normalEquipments.push(row['장비ID']);
                }
            } else if (row['상태'] === '비정상') {
                abnormalCount++;
                if (row['장비ID']) {
                    abnormalEquipments.push(row['장비ID']);
                }
            }
        });

        // 임시 파일 삭제
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }

        // 결과 반환
        res.json({
            success: true,
            team: currentTeam,
            fileName: latestFile.name,
            analysis: {
                normalCount: normalCount,
                abnormalCount: abnormalCount,
                normalEquipments: [...new Set(normalEquipments)], // 중복 제거
                abnormalEquipments: [...new Set(abnormalEquipments)] // 중복 제거
            }
        });

    } catch (error) {
        console.error('Autobe backup analysis error:', error);
        
        // 임시 파일 정리
        const localPath = path.join(__dirname, 'temp_autobe_analyze.xlsx');
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
        
        res.status(500).json({ error: '분석 중 오류가 발생했습니다: ' + error.message });
    }
});

// 장비 확인 상태 업데이트 API
app.post('/updateEquipmentCheck', async function (req, res) {
    const { equipmentId, employeeNumber, timestamp } = req.body;

    if (!equipmentId || !employeeNumber) {
        return res.status(400).json({ error: '장비ID와 사번이 필요합니다.' });
    }

    try {
        // 현재 시간을 기준으로 해당 팀 판단 (분석 로직과 동일)
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        
        let currentTeam;
        if ((currentHour === 7 && currentMinute >= 0) || (currentHour === 8 && currentMinute < 30)) {
            currentTeam = 'A-TEAM';
        } else if ((currentHour === 15 && currentMinute >= 0) || (currentHour === 16 && currentMinute < 30)) {
            currentTeam = 'B-TEAM';
        } else if ((currentHour === 23 && currentMinute >= 0) || (currentHour === 0 && currentMinute < 30)) {
            currentTeam = 'C-TEAM';
        } else {
            if (currentHour < 7 || (currentHour === 0 && currentMinute < 30)) {
                currentTeam = 'C-TEAM';
            } else if (currentHour < 15) {
                currentTeam = 'A-TEAM';
            } else {
                currentTeam = 'B-TEAM';
            }
        }

        // FTP 연결
        const client = new ftp.Client();
        client.ftp.verbose = true;
        client.ftp.pasv = true;
        
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        // 백업 경로 설정 (오늘 날짜)
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const backupPath = `RPA/Autobe_Backup/${year}/${month}/${day}/`;

        // 해당 팀의 최신 파일 찾기
        const files = await client.list(backupPath);
        const teamFiles = files
            .filter(file => file.type !== 2)
            .filter(file => file.name.includes(`_${currentTeam}_`) && file.name.endsWith('.xlsx'))
            .sort((a, b) => {
                const timestampA = a.name.match(/(\d{8}_\d{4})/)?.[1] || '00000000_0000';
                const timestampB = b.name.match(/(\d{8}_\d{4})/)?.[1] || '00000000_0000';
                return timestampB.localeCompare(timestampA);
            });

        if (teamFiles.length === 0) {
            client.close();
            return res.status(404).json({ error: `${currentTeam} 팀의 백업 파일을 찾을 수 없습니다.` });
        }

        const latestFile = teamFiles[0];
        const remotePath = backupPath + latestFile.name;
        const localPath = path.join(__dirname, 'temp_update.xlsx');

        console.log(`Updating equipment check: ${equipmentId} by ${employeeNumber} in file: ${latestFile.name}`);

        // FTP에서 파일 다운로드
        await client.downloadTo(localPath, remotePath);

        // 엑셀 파일 읽기 및 수정
        const workbook = XLSX.readFile(localPath);
        const sheetNames = workbook.SheetNames;
        
        if (sheetNames.length < 3) {
            client.close();
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
            return res.status(400).json({ error: '세 번째 시트가 존재하지 않습니다.' });
        }

        const thirdSheet = workbook.Sheets[sheetNames[2]];
        const data = XLSX.utils.sheet_to_json(thirdSheet, { header: 1 });

        // 헤더 행 찾기
        let headerRowIndex = -1;
        let equipmentIdColIndex = -1;
        let checkStatusColIndex = -1;

        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            if (row && Array.isArray(row)) {
                const equipmentCol = row.findIndex(cell => cell === '장비ID');
                const checkCol = row.findIndex(cell => cell === '확인');
                
                if (equipmentCol !== -1 && checkCol !== -1) {
                    headerRowIndex = i;
                    equipmentIdColIndex = equipmentCol;
                    checkStatusColIndex = checkCol;
                    break;
                }
            }
        }

        if (headerRowIndex === -1) {
            client.close();
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
            return res.status(400).json({ error: '헤더를 찾을 수 없습니다.' });
        }

        // 해당 장비ID 행 찾아서 확인 상태 업데이트
        let updated = false;
        for (let i = headerRowIndex + 1; i < data.length; i++) {
            const row = data[i];
            if (row && row[equipmentIdColIndex] === equipmentId) {
                row[checkStatusColIndex] = 'check';
                updated = true;
                break;
            }
        }

        if (!updated) {
            client.close();
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
            return res.status(404).json({ error: '해당 장비ID를 찾을 수 없습니다.' });
        }

        // 수정된 데이터를 다시 시트에 쓰기
        const newSheet = XLSX.utils.aoa_to_sheet(data);
        workbook.Sheets[sheetNames[2]] = newSheet;

        // 로컬에 저장
        XLSX.writeFile(workbook, localPath);

        // FTP에 업로드
        await client.uploadFrom(localPath, latestFile.name);
        client.close();

        // 임시 파일 삭제
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }

        res.json({ success: true, message: '확인 처리가 완료되었습니다.' });

    } catch (error) {
        console.error('Equipment check update error:', error);
        
        // 임시 파일 정리
        const localPath = path.join(__dirname, 'temp_update.xlsx');
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
        
        res.status(500).json({ error: '업데이트 중 오류가 발생했습니다: ' + error.message });
    }
});

app.get('/viewExcelSheet', async function (req, res) {
    if (!globalItem || !globalItem.STATUS || !globalItem.LOT_ID || !globalItem.EQPID) {
        return res.status(400).send('STATUS, LOT_ID 또는 DEVICE 정보가 설정되지 않았습니다.');
    }

    // 세션에서 캠퍼스 정보 가져오기 (우선순위 1)
    const sessionCampus = req.session.campus;
    
    // globalItem.EQPID로 캠퍼스 판단 (우선순위 2)
    const equipmentCampus = getEquipmentCampus(globalItem.EQPID);
    
    // 최종 캠퍼스 결정 (세션 > 장비매핑)
    let targetCampus = sessionCampus;
    if (sessionCampus === 'ns2CAM') targetCampus = 'NS2';
    else if (sessionCampus === 'ns3CAM') targetCampus = 'NS3';
    else if (!targetCampus) targetCampus = equipmentCampus;
    
    // 캠퍼스별 경로 설정
    let basePath;
    if (targetCampus === 'NS2') {
        basePath = `RPA/Report/ns2_PMIC/${globalItem.STATUS}/${globalItem.EQPID}/`;
    } else {
        // NS3 또는 기본 경로
        basePath = `RPA/Report/${globalItem.STATUS}/${globalItem.EQPID}/`;
    }
    const client = new ftp.Client();
    client.ftp.verbose = true;
    // 여기요!! - 리눅스 FTP 서버용 패시브 모드 설정
    client.ftp.pasv = true;
    const localPath = path.join(__dirname, 'temp.xlsx');

    try {
        await client.access({
            host: "192.168.223.23", // 변경된 FTP 서버 호스트
            user: "hyperauto",      // 변경된 사용자 이름
            password: "Gkdlvj123!@#", // 변경된 비밀번호
            secure: false
        });

        // 해당 경로의 파일 목록 가져오기
        console.log(`Files path: ${basePath}`); // 경로 로깅
        const files = await client.list(basePath);
        console.log('Files in directory:', files); // 파일 목록 로깅
        
        // 여기요!! - 리눅스 파일시스템 대응: 디렉토리 제외 필터링 추가
        const matchingFiles = files
            .filter(file => file.type !== 2) // 디렉토리(type 2) 제외
            .filter(file => file.name.startsWith(`${globalItem.LOT_ID}_${globalItem.EQPID}_${globalItem.STATUS}_`) && file.name.endsWith('.xlsx'));
        
        console.log('Matching files:', matchingFiles); // 매칭된 파일 로깅

        if (matchingFiles.length === 0) {
            throw new Error(`No matching files found in ${basePath}`);
        }

        // 가장 최신 날짜의 파일 찾기
        const latestFile = matchingFiles.sort((a, b) => b.name.localeCompare(a.name))[0].name;
        const remotePath = `${basePath}${latestFile}`;
        console.log(`Downloading file from: ${remotePath}`); // 다운로드 경로 로깅

        await client.downloadTo(localPath, remotePath);

        // 파일이 존재하는지 확인
        if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(2); // 두 번째 시트

        // B2:S33 범위를 HTML로 변환
        let html = '<table border="1" style="border-collapse: collapse; text-align: center; width: 100%;">';
        const merges = worksheet._merges;
        for (let rowNumber = 2; rowNumber <= 33; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const isLastRow = rowNumber === 33; // 마지막 행인지 확인
            html += `<tr${isLastRow ? ' style="background-color: yellow;"' : ''}>`;
            for (let colNumber = 2; colNumber <= 19; colNumber++) {
                const cell = row.getCell(colNumber);
                const cellValue = cell.value || '';
                const cellAddress = cell.address;

                // 병합된 셀 확인
                const mergeCell = merges[cellAddress];
                if (mergeCell) {
                    const { top, left, bottom, right } = mergeCell;
                    const rowspan = bottom - top + 1;
                    const colspan = right - left + 1;
                    html += `<td rowspan="${rowspan}" colspan="${colspan}" style="border: 1px solid black;">${cellValue}</td>`;
                } else {
                    // 병합된 셀의 시작 셀만 값을 표시하고 나머지 셀은 비워둠
                    const isMerged = Object.values(merges).some(merge => {
                        const { top, left, bottom, right } = merge;
                        return rowNumber >= top && rowNumber <= bottom && colNumber >= left && colNumber <= right;
                    });
                    if (!isMerged) {
                        html += `<td style="border: 1px solid black;">${cellValue}</td>`;
                    }
                }
            }
            html += '</tr>';
        }
        html += '</table>';

        res.send(html);
    } catch (error) {
        console.error('Error processing Excel file:', error);
        console.error('Error details:', error.stack); // 스택 트레이스 추가
        res.status(500).send(`Error processing Excel file: ${error.message}`);
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath); // 임시 파일 삭제
        }
    }
});

app.use(express.static(path.join(__dirname, 'public'))); 


// Probemark 이미지 다운로드 (EQPID 경로 추가)
app.get('/fetchImages', async function (req, res) {
    if (!globalItem || !globalItem.STATUS || !globalItem.LOT_ID || !globalItem.EQPID) {
        return res.status(400).send('STATUS, LOT_ID 또는 EQPID 정보가 설정되지 않았습니다.');
    }

    // 세션에서 캠퍼스 정보 가져오기 (우선순위 1)
    const sessionCampus = req.session.campus;
    
    // globalItem.EQPID로 캠퍼스 판단 (우선순위 2)
    const equipmentCampus = getEquipmentCampus(globalItem.EQPID);
    
    // 최종 캠퍼스 결정 (세션 > 장비매핑)
    let targetCampus = sessionCampus;
    if (sessionCampus === 'ns2CAM') targetCampus = 'NS2';
    else if (sessionCampus === 'ns3CAM') targetCampus = 'NS3';
    else if (!targetCampus) targetCampus = equipmentCampus;
    
    // 캠퍼스별 경로 설정
    let basePath;
    if (targetCampus === 'NS2') {
        basePath = `RPA/probemark_Image/ns2_PMIC/${globalItem.STATUS}/${globalItem.EQPID}/${globalItem.LOT_ID}/`;
    } else {
        // NS3 또는 기본 경로
        basePath = `RPA/probemark_Image/${globalItem.STATUS}/${globalItem.EQPID}/${globalItem.LOT_ID}/`;
    }
    const client = new ftp.Client();
    client.ftp.verbose = true;
    // 여기요!! - 리눅스 FTP 서버용 패시브 모드 설정
    client.ftp.pasv = true;

    try {
        await client.access({
            host: "192.168.223.23", // 변경된 FTP 서버 호스트
            user: "hyperauto",      // 변경된 사용자 이름
            password: "Gkdlvj123!@#", // 변경된 비밀번호
            secure: false
        });

        console.log(`Files path: ${basePath}`); // 경로 로깅
        
        // LOT_ID 뒤에 붙는 숫자가 가장 큰 폴더 찾기
        const lotFolders = await client.list(basePath);
        // 여기요!! - 디렉토리만 필터링
        const lotFoldersFiltered = lotFolders.filter(folder => folder.type === 2); // type 2는 디렉토리
        
        if (lotFoldersFiltered.length === 0) {
            throw new Error(`No folders found in ${basePath}`);
        }
        
        const latestLotFolder = lotFoldersFiltered
            .filter(folder => folder.name.startsWith(globalItem.LOT_ID + '.'))
            .sort((a, b) => parseInt(b.name.split('.')[1]) - parseInt(a.name.split('.')[1]))[0].name;

        const lotPath = `${basePath}${latestLotFolder}/`;
        console.log(`Lot path: ${lotPath}`); // 로깅 추가

        // 가장 최신 날짜&시간 폴더 찾기
        const dateFolders = await client.list(lotPath);
        // 여기요!! - 디렉토리만 필터링
        const dateFoldersFiltered = dateFolders.filter(folder => folder.type === 2);
        
        if (dateFoldersFiltered.length === 0) {
            throw new Error(`No date folders found in ${lotPath}`);
        }
        
        const latestDateFolder = dateFoldersFiltered
            .sort((a, b) => b.name.localeCompare(a.name))[0].name;

        const remotePath = `${lotPath}${latestDateFolder}/`;
        console.log(`Remote path: ${remotePath}`); // 로깅 추가
        
        const localDir = path.join(__dirname, 'public', 'images');

        const files = await client.list(remotePath);
        // 여기요!! - 파일만 필터링 (디렉토리 제외)
        //const bmpFiles = files.filter(file => file.type !== 2 && file.name.endsWith('.bmp'));
        const bmpFiles = files.filter(file => file.name.endsWith('.bmp') || file.name.endsWith('.jpg'));

        // Ensure local directory exists
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
        }

        console.log(`Found ${bmpFiles.length} BMP files`); // 로깅 추가

        // Download images to local directory
        for (const file of bmpFiles) {
            const localPath = path.join(localDir, file.name);
            await client.downloadTo(localPath, `${remotePath}${file.name}`);
        }

        const images = bmpFiles.map(file => ({
            name: file.name,
            path: `/images/${file.name}`
        }));

        res.json(images);
    } catch (error) {
        console.error('Error fetching images:', error);
        console.error('Error details:', error.stack); // 스택 트레이스 추가
        res.status(500).send(`Error fetching images: ${error.message}`);
    } finally {
        client.close();
    }
});

// Contact setup 후 Run동작 실행
app.post('/updateStatus', async (req, res) => {
    const { eqpid, startTime } = req.body;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET RPA_STATUS = 'Run' 
             WHERE EQP_ID = :eqpid 
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')
             AND RPA_STATUS IN  ('Check', 'Error')`,
            [eqpid, startTime],
            { autoCommit: true }
        );

        if (result.rowsAffected === 0) {
            res.status(404).send('No rows updated');
        } else {
            res.send('Status updated successfully');
        }

        await connection.close();
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).send('Error updating status');
    }
});

// STOP 동작 실행
app.post('/updateStatus_2', async (req, res) => {
    const { eqpid, startTime, status, finally: finallyStatus, userId } = req.body;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET RPA_STATUS = :status, FINALLY = :finallyStatus, USERID = :userId
             WHERE EQP_ID = :eqpid 
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')
             AND RPA_STATUS IN ('Check', 'Error', 'Run')`,
            [status, finallyStatus, userId, eqpid, startTime],
            { autoCommit: true }
        );

        if (result.rowsAffected === 0) {
            res.status(404).send('No rows updated');
        } else {
            res.send('Status updated successfully');
        }

        await connection.close();
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).send('Error updating status');
    }
});

// app.post('/updateStatusWithReason', async (req, res) => {
//     const { eqpid, startTime, reason, detail } = req.body;
    
//     if (!eqpid || !startTime || !reason || !detail) {
//         return res.status(400).send('필수 파라미터가 누락되었습니다.');
//     }
    
//     let connection;
//     try {
//         connection = await oracledb.getConnection(dbConfig1);
        
//         // RPA 테이블에 사유와 상세 내용 저장 (ACTION_SORT, ACTION_COMMENT 컬럼 사용)
//         const result = await connection.execute(
//             `UPDATE RPA_ADMIN.RPA 
//              SET RPA_STATUS = 'OM', 
//                  ACTION_SORT = :reason, 
//                  ACTION_COMMENT = :detail
//              WHERE EQP_ID = :eqpid 
//              AND TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS') BETWEEN 
//                  START_TIME - INTERVAL '1' SECOND AND START_TIME + INTERVAL '1' SECOND`,
//             {
//                 reason: reason,
//                 detail: detail,
//                 eqpid: eqpid,
//                 startTime: startTime
//             },
//             { autoCommit: true }
//         );
        
//         if (result.rowsAffected === 0) {
//             return res.status(404).send('해당하는 RPA 상태 정보를 찾을 수 없습니다.');
//         }
        
//         res.status(200).send('상태 업데이트 완료');
//     } catch (error) {
//         console.error('Error updating RPA status with reason:', error);
//         res.status(500).send('데이터베이스 오류 발생');
//     } finally {
//         if (connection) {
//             try {
//                 await connection.close();
//             } catch (error) {
//                 console.error('Error closing database connection:', error);
//             }
//         }
//     }
// });

app.post('/updateStatusWithReason', async (req, res) => {
    const { eqpid, startTime, reason, detail } = req.body;
    
    if (!eqpid || !startTime || !reason || !detail) {
        return res.status(400).send('필수 파라미터가 누락되었습니다.');
    }
    
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        
        // 1. 먼저 원래 인스턴스의 데이터 조회
        const queryResult = await connection.execute(
            `SELECT * FROM RPA_ADMIN.RPA 
             WHERE EQP_ID = :eqpid 
             AND TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS') BETWEEN 
                 START_TIME - INTERVAL '1' SECOND AND START_TIME + INTERVAL '1' SECOND`,
            {
                eqpid: eqpid,
                startTime: startTime
            },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        
        if (queryResult.rows.length === 0) {
            return res.status(404).send('해당하는 RPA 상태 정보를 찾을 수 없습니다.');
        }
        
        // 2. 원래 인스턴스의 ACTION_SORT, ACTION_COMMENT 값을 업데이트
        const updateResult = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET ACTION_SORT = :reason, 
                 ACTION_COMMENT = :detail,
                 FINALLY = 'Ok'
             WHERE EQP_ID = :eqpid 
             AND TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS') BETWEEN 
                 START_TIME - INTERVAL '1' SECOND AND START_TIME + INTERVAL '1' SECOND`,
            {
                reason: reason,
                detail: detail,
                eqpid: eqpid,
                startTime: startTime
            },
            { autoCommit: false } // 트랜잭션 유지
        );
        
        // 3. 새 인스턴스 생성을 위한 데이터 준비
        const originalRow = queryResult.rows[0];
        
        // 새 레코드에 사용할 값들을 저장
        let insertParams = {};
        
        // 원본 데이터의 모든 컬럼 복사 (ID 제외)
        for (const [key, value] of Object.entries(originalRow)) {
            if (key !== 'ID') {
                insertParams[key] = value;
            }
        }
        
        // 필요한 컬럼 값 변경
        insertParams.RPA_STATUS = 'OM';
        insertParams.LOT_ID = ''; // LOT_ID를 공백으로 설정
        insertParams.ACTION_SORT = reason;
        insertParams.ACTION_COMMENT = detail;
        
        // 4. 동적 SQL 작성
        const columns = Object.keys(insertParams).filter(key => key !== 'ID');
        const placeholders = columns.map(col => `:${col}`);
        
        const insertQuery = `
            INSERT INTO RPA_ADMIN.RPA (${columns.join(', ')})
            VALUES (${placeholders.join(', ')})
        `;
        
        // 5. 새 레코드 삽입
        await connection.execute(insertQuery, insertParams, { autoCommit: true });
        
        res.status(200).send('상태 업데이트 완료');
    } catch (error) {
        console.error('Error updating RPA status with reason:', error);
        res.status(500).send('데이터베이스 오류 발생: ' + error.message);
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                console.error('Error closing database connection:', error);
            }
        }
    }
});

// // RPA 완료시 FINALLY 컬럼 값 수정
// app.post('/updateFinallyColumn', async (req, res) => {
//     const { eqpid, startTime, userId } = req.body;
//     console.log('Received request to updateFinallyColumn:', { eqpid, startTime, userId });

//     try {
//         const connection = await oracledb.getConnection(dbConfig1);
//         const result = await connection.execute(
//             `UPDATE RPA_ADMIN.RPA 
//              SET FINALLY = 'Ok', USERID = :userId
//              WHERE EQP_ID = :eqpid
//              AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')`,
//             { eqpid, startTime, userId }, // 바인드 변수 수정
//             { autoCommit: true }
//         );

//         console.log('Update result:', result);

//         if (result.rowsAffected === 0) {
//             console.log('No rows updated for:', { eqpid, startTime, userId });
//             res.status(404).send('No rows updated');
//         } else {
//             res.json({ success: true, message: 'FINALLY 컬럼 값이 성공적으로 수정되었습니다.' });
//         }

//         await connection.close();
//     } catch (error) {
//         console.error('Error updating FINALLY column:', error);
//         res.status(500).send('Error updating FINALLY column');
//     }
// });

// app.post('/updateFinallyColumn', async (req, res) => {
//     const { eqpid, startTime, userId, finally: finallyValue } = req.body; // 'finally' 값 추가
//     console.log('Received request to updateFinallyColumn:', { eqpid, startTime, userId, finallyValue });

//     try {
//         const connection = await oracledb.getConnection(dbConfig1);
//         const result = await connection.execute(
//             `UPDATE RPA_ADMIN.RPA 
//              SET FINALLY = :finallyValue, USERID = :userId
//              WHERE EQP_ID = :eqpid
//              AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')`,
//             { eqpid, startTime, userId, finallyValue }, // 바인드 변수 수정
//             { autoCommit: true }
//         );

//         console.log('Update result:', result);

//         if (result.rowsAffected === 0) {
//             console.log('No rows updated for:', { eqpid, startTime, userId });
//             res.status(404).send('No rows updated');
//         } else {
//             res.json({ success: true, message: `'Finally' 컬럼 값이 성공적으로 '${finallyValue}'로 수정되었습니다.` });
//         }

//         await connection.close();
//     } catch (error) {
//         console.error('Error updating FINALLY column:', error);
//         res.status(500).send('Error updating FINALLY column');
//     }
// });

app.post('/updateFinallyColumn', async (req, res) => {
    const { eqpid, startTime, userId, finallyValue } = req.body; // finallyValue 추가
    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET FINALLY = :finallyValue, USERID = :userId
             WHERE EQP_ID = :eqpid
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')`,
            { eqpid, startTime, userId, finallyValue }, // finallyValue 바인딩
            { autoCommit: true }
        );

        if (result.rowsAffected === 0) {
            res.status(404).send('No rows updated');
        } else {
            res.json({ success: true, message: 'FINALLY 컬럼 값이 성공적으로 수정되었습니다.' });
        }
    } catch (error) {
        console.error('Error updating FINALLY column:', error);
        res.status(500).send('Error updating FINALLY column');
    }
});


// 전역변수 설정
let globalItem = null;

// 특정 엔드포인트에서 globalItem 설정
app.post('/setGlobalItem', (req, res) => {
    globalItem = req.body;
    res.json({ success: true, message: 'globalItem이 설정되었습니다.' });
});

// 한도견본 출력
app.get('/generate-image', async (req, res) => {
    if (!globalItem || !globalItem.DEVICE) {
        return res.status(400).send('DEVICE 정보가 설정되지 않았습니다.');
    }

    // 세션에서 캠퍼스 정보 가져오기 (우선순위 1)
    const sessionCampus = req.session.campus;
    
    // globalItem.EQPID로 캠퍼스 판단 (우선순위 2) - EQPID가 없으면 DEVICE로 판단
    const equipmentId = globalItem.EQPID || globalItem.DEVICE;
    const equipmentCampus = getEquipmentCampus(equipmentId);
    
    // 최종 캠퍼스 결정 (세션 > 장비매핑)
    let targetCampus = sessionCampus;
    if (sessionCampus === 'ns2CAM') targetCampus = 'NS2';
    else if (sessionCampus === 'ns3CAM') targetCampus = 'NS3';
    else if (!targetCampus) targetCampus = equipmentCampus;

    const client = new ftp.Client();
    client.ftp.verbose = true;
    const localPath = path.join(__dirname, 'temp.xlsx');
    const device = globalItem.DEVICE; // 전역 변수에서 DEVICE 값을 가져옴

    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        // 캠퍼스별 경로 설정
        let remotePath;
        if (targetCampus === 'NS2') {
            remotePath = `RPA/제품별한도견본/ns2_PMIC/${device}_한도견본.xlsx`;
        } else {
            // NS3 또는 기본 경로
            remotePath = `RPA/제품별한도견본/${device}_한도견본.xlsx`;
        }
        await client.downloadTo(localPath, remotePath);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(1);

        // A1:A10 범위를 추출 (병합된 셀 고려)
        let textData = [];
        let previousValue = null;
        for (let rowNumber = 1; rowNumber <= 10; rowNumber++) {
            const cell = worksheet.getRow(rowNumber).getCell(1); // A열의 셀 값 추출
            const cellValue = cell.value !== null ? cell.value.toString() : '0'; // 셀 값이 null인 경우 '0'으로 설정
            if (cellValue !== previousValue) {
                textData.push(cellValue);
                previousValue = cellValue;
            }
        }

        // 두 번째 시트에서 이미지 추출
        const secondSheet = workbook.getWorksheet(2);
        let imageData = [];
        const images = secondSheet.getImages();
        images.forEach(image => {
            const { range, imageId } = image;
            const imageBuffer = workbook.model.media.find(media => media.index === imageId).buffer;
            const base64Image = imageBuffer.toString('base64');
            imageData.push(`data:image/png;base64,${base64Image}`);
        });

        res.json({ textData, imageData });
    } catch (error) {
        console.error('Error generating image:', error);
        res.status(500).send('Error generating image');
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
    }
});

// 누적 최종데이터 추출
app.get('/Detailed-Report', async function (req, res) {
    const { fileName, sortValue, eqpid } = req.query;  // eqpId 대신 machine 사용
    console.log("Received Detailed-Report request:", { fileName, sortValue, eqpid });
    
    if (!fileName || !sortValue || !eqpid) {
        return res.status(400).send('fileName, sortValue, and machine parameters are required');
    }

    // 세션에서 캠퍼스 정보 가져오기 (우선순위 1)
    const sessionCampus = req.session.campus;
    
    // eqpid로 캠퍼스 판단 (우선순위 2)
    const equipmentCampus = getEquipmentCampus(eqpid);
    
    // 최종 캠퍼스 결정 (세션 > 장비매핑)
    let targetCampus = sessionCampus;
    if (sessionCampus === 'ns2CAM') targetCampus = 'NS2';
    else if (sessionCampus === 'ns3CAM') targetCampus = 'NS3';
    else if (!targetCampus) targetCampus = equipmentCampus;
    
    // 캠퍼스별 경로 설정
    let basePath;
    if (targetCampus === 'NS2') {
        basePath = `RPA/Report/ns2_PMIC/${sortValue}/${eqpid}/`;
    } else {
        // NS3 또는 기본 경로
        basePath = `RPA/Report/${sortValue}/${eqpid}/`;
    }
    console.log(`Base path: ${basePath}`);
    
    const client = new ftp.Client();
    client.ftp.verbose = true;
    const localPath = path.join(__dirname, 'temp.xlsx');

    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        // 해당 경로의 파일 목록 가져오기
        const files = await client.list(basePath);
        console.log('Files in directory:', files); // 파일 목록 로그 출력

        // 파일 이름 비교 로그 추가
        const fileNameOnly = path.basename(fileName); // 경로를 제거한 파일 이름
        files.forEach(file => {
            console.log(`Comparing: ${file.name} with ${fileNameOnly}`);
        });

        const matchingFiles = files.filter(file => file.name === fileNameOnly);
        console.log('Matching files:', matchingFiles); // 매칭되는 파일 로그 출력

        if (matchingFiles.length === 0) {
            throw new Error('No matching files found');
        }

        const remotePath = `${basePath}${fileNameOnly}`;
        console.log(`Attempting to download file from: ${remotePath}`); // 경로를 로그로 출력

        await client.downloadTo(localPath, remotePath);

        // 파일이 존재하는지 확인
        if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(2); // 두 번째 시트

        // B2:S58 범위를 HTML로 변환
        let html = '<table border="1" style="border-collapse: collapse; text-align: center; width: 100%;">';
        const merges = worksheet._merges;
        for (let rowNumber = 2; rowNumber <= 22; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            html += '<tr>';
            for (let colNumber = 2; colNumber <= 19; colNumber++) {
                const cell = row.getCell(colNumber);
                const cellValue = cell.value || '';
                const cellAddress = cell.address;

                // 병합된 셀 확인
                const mergeCell = merges[cellAddress];
                if (mergeCell) {
                    const { top, left, bottom, right } = mergeCell;
                    const rowspan = bottom - top + 1;
                    const colspan = right - left + 1;
                    html += `<td rowspan="${rowspan}" colspan="${colspan}" style="border: 1px solid black;">${cellValue}</td>`;
                } else {
                    // 병합된 셀의 시작 셀만 값을 표시하고 나머지 셀은 비워둠
                    const isMerged = Object.values(merges).some(merge => {
                        const { top, left, bottom, right } = merge;
                        return rowNumber >= top && rowNumber <= bottom && colNumber >= left && colNumber <= right;
                    });
                    if (!isMerged) {
                        html += `<td style="border: 1px solid black;">${cellValue}</td>`;
                    }
                }
            }
            html += '</tr>';
        }
        html += '</table>';

        // 이미지 추출
        const images = worksheet.getImages();
        let imageHtml = '<div style="display: flex; flex-wrap: wrap;">';
        for (const image of images) {
            const imageId = image.imageId;
            const imageBuffer = workbook.model.media.find(media => media.index === imageId).buffer;
            const base64Image = imageBuffer.toString('base64');
            imageHtml += `
                <div style="width: 50%; padding: 10px; box-sizing: border-box;">
                    <div style="border: 1px solid black; padding: 10px;">
                        <img src="data:image/png;base64,${base64Image}" style="width: 100%; height: auto;" />
                    </div>
                </div>`;
        }
        imageHtml += '</div>';

        html += imageHtml;

        res.send(html);
    } catch (error) {
        console.error('Error fetching Excel file:', error);
        res.status(500).send('Error fetching Excel file');
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath); // 임시 파일 삭제
        }
    }
});

// Ball Size 정의
async function getBallSize(device) {
    let connection;
    try {
        // device의 앞 8자리만 추출
        const devicePrefix = device.substring(0, 8);
        console.log(`원본 장비명: ${device}, 검색용 장비명(앞 8자리): ${devicePrefix}`);
        
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `SELECT BALL_SIZE FROM RPA_ADMIN.ball_size WHERE DEVICE = :devicePrefix`,
            [devicePrefix]
        );
        
        if (result.rows.length > 0) {
            console.log(`장비 ${devicePrefix}의 볼 사이즈: ${result.rows[0][0]}`);
            return result.rows[0][0]; // BALL_SIZE 값 반환
        } else {
            console.log(`장비 ${devicePrefix}에 대한 볼 사이즈 정보가 없습니다.`);
            return 80; // 기본 크기 반환 (없을 경우 기본값)
        }
    } catch (err) {
        console.error('볼 사이즈 조회 중 오류 발생:', err);
        return 80; // 오류 발생 시 기본값 반환
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('DB 연결 종료 중 오류:', err);
            }
        }
    }
}


app.get('/setCursorStyle', async function (req, res) {
    console.log("setCursorStyle 호출됨");
    
    if (!globalItem || !globalItem.DEVICE) {
        console.log("globalItem 또는 DEVICE가 없음:", globalItem);
        return res.status(400).send('DEVICE 정보가 설정되지 않았습니다.');
    }

    const device = globalItem.DEVICE;
    console.log("현재 장비명:", device);

    try {
        // 배율 감안하여 2배율 적용
        const ballSize = await getBallSize(device) * 2;
        console.log("조회된 볼 사이즈:", ballSize);
        
        const innerCircleSize = ballSize * 0.6;
        
        // 크기에 따라 SVG 또는 CSS 방식 선택
        const useSvgCursor = ballSize <= 128; // 128px 이하일 때만 SVG 커서 사용
        
        if (useSvgCursor) {
            // SVG 방식
            const cursorSvg = `
                <svg width="${ballSize}" height="${ballSize}" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="${ballSize / 2}" cy="${ballSize / 2}" r="${ballSize / 2}" stroke="green" stroke-width="2" fill="none" />
                    <circle cx="${ballSize / 2}" cy="${ballSize / 2}" r="${innerCircleSize / 2}" stroke="red" stroke-width="2" fill="none" />
                    <text x="${ballSize + 5}" y="${ballSize / 2 + 5}" font-family="Arial" font-size="14" fill="black" font-weight="bold">${ballSize}</text>
                </svg>
            `;
            const cursorUrl = `data:image/svg+xml;base64,${Buffer.from(cursorSvg).toString('base64')}`;
            
            const styleCode = `
                #inspection-images-container:hover {
                    cursor: url('${cursorUrl}') ${ballSize / 2} ${ballSize / 2}, auto;
                }
                
                #ball-size-badge {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background-color: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 10px;
                    border-radius: 5px;
                    font-size: 16px;
                    font-weight: bold;
                    z-index: 9999;
                }
            `;
            
            // 여기요!! - SVG 방식에서 장비명 추가
            const scriptCode = `
                <script>
                    const existingBadge = document.getElementById('ball-size-badge');
                    if (existingBadge) existingBadge.remove();
                    
                    const badge = document.createElement('div');
                    badge.id = 'ball-size-badge';
                    badge.innerHTML = '<div>장비: ${device} | 볼 사이즈: ${ballSize}</div>';
                    document.body.appendChild(badge);
                    
                    // 기존 커스텀 커서 제거 (있을 경우)
                    const existingCursor = document.getElementById('custom-cursor');
                    if (existingCursor) existingCursor.remove();
                </script>
            `;
            
            res.send(styleCode + scriptCode);
        } else {
            // CSS/JS 방식 (큰 사이즈용)
            const styleCode = `
                <style>
                    #inspection-images-container {
                        position: relative !important;
                        cursor: none !important;
                    }
                    
                    #custom-cursor {
                        position: absolute;
                        width: ${ballSize}px;
                        height: ${ballSize}px;
                        border: 2px solid green;
                        border-radius: 50%;
                        pointer-events: none;
                        transform: translate(-50%, -50%);
                        z-index: 9999;
                        display: none;
                    }
                    
                    #custom-cursor::after {
                        content: "";
                        position: absolute;
                        width: ${innerCircleSize}px;
                        height: ${innerCircleSize}px;
                        border: 2px solid red;
                        border-radius: 50%;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                    }
                    
                    #ball-size-badge {
                        position: fixed;
                        top: 20px;
                        right: 20px;
                        background-color: rgba(0, 0, 0, 0.8);
                        color: white;
                        padding: 10px;
                        border-radius: 5px;
                        font-size: 16px;
                        font-weight: bold;
                        z-index: 9999;
                    }
                </style>
            `;
            
            // CSS 방식에서 장비명 추가
            const scriptCode = `
                <script>
                    // 배지 업데이트
                    const existingBadge = document.getElementById('ball-size-badge');
                    if (existingBadge) existingBadge.remove();
                    
                    const badge = document.createElement('div');
                    badge.id = 'ball-size-badge';
                    badge.innerHTML = '<div>장비: ${device} | 볼 사이즈: ${ballSize}</div>';
                    document.body.appendChild(badge);
                    
                    // 커스텀 커서 생성
                    const existingCursor = document.getElementById('custom-cursor');
                    if (existingCursor) existingCursor.remove();
                    
                    const cursor = document.createElement('div');
                    cursor.id = 'custom-cursor';
                    
                    // 이벤트 처리
                    window.addEventListener('DOMContentLoaded', function() {
                        const container = document.getElementById('inspection-images-container');
                        if (container) {
                            container.appendChild(cursor);
                            
                            container.addEventListener('mousemove', function(e) {
                                const rect = container.getBoundingClientRect();
                                const x = e.clientX - rect.left;
                                const y = e.clientY - rect.top;
                                cursor.style.left = x + 'px';
                                cursor.style.top = y + 'px';
                                cursor.style.display = 'block';
                            });
                            
                            container.addEventListener('mouseleave', function() {
                                cursor.style.display = 'none';
                            });
                            
                            container.addEventListener('mouseenter', function() {
                                cursor.style.display = 'block';
                            });
                        }
                    });
                    
                    if (document.readyState === 'interactive' || document.readyState === 'complete') {
                        const event = new Event('DOMContentLoaded');
                        window.dispatchEvent(event);
                    }
                </script>
            `;
            
            res.send(styleCode + scriptCode);
        }
    } catch (error) {
        console.error('커서 스타일 설정 중 오류:', error);
        
        // 오류 발생 시에도 장비명 포함
        const defaultBallSize = 80;
        const defaultStyle = `
            <style>
                #ball-size-badge {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background-color: rgba(255, 0, 0, 0.8);
                    color: white;
                    padding: 10px;
                    border-radius: 5px;
                    font-size: 16px;
                    font-weight: bold;
                    z-index: 9999;
                }
            </style>
        `;
        
        const defaultScript = `
            <script>
                const existingBadge = document.getElementById('ball-size-badge');
                if (existingBadge) existingBadge.remove();
                
                const badge = document.createElement('div');
                badge.id = 'ball-size-badge';
                badge.innerHTML = '<div>장비: ${device} | 볼 사이즈: ${defaultBallSize} (오류)</div>';
                document.body.appendChild(badge);
            </script>
        `;
        
        res.send(defaultStyle + defaultScript);
    }
});


// getErrorDetails 엔드포인트 추가
app.get('/getErrorDetails', async function (req, res) {
    const { eqpid, lotId } = req.query;
    
    if (!eqpid || !lotId) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }
    
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            SELECT 
                RPA_STATUS,
                ERROR_ME AS ERROR_MESSAGE
            FROM 
                RPA_ADMIN.RPA r
            WHERE 
                r.EQP_ID = :eqpid 
                AND r.LOT_ID = :lotId
                AND r.RPA_STATUS = 'Error'
            ORDER BY START_TIME DESC
        `, [eqpid, lotId]);
        
        // 결과를 객체 배열로 변환
        const errorDetails = result.rows.map(row => ({
            RPA_STATUS: row[0],
            ERROR_MESSAGE: row[1] || '상세 오류 메시지가 없습니다.'
        }));
        
        res.json(errorDetails);
    } catch (err) {
        console.error('Error fetching error details:', err);
        res.status(500).json({ error: '에러 정보를 가져오는 데 실패했습니다.' });
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('DB 연결 종료 중 오류:', err);
            }
        }
    }
});

// Remote 엔드포인트 추가
app.get('/remote', function (req, res) {
    res.sendFile(path.join(__dirname, 'Remote.html'));
});

// Autobe Check 엔드포인트 (모달 사용으로 더 이상 필요 없음)
// app.get('/autobe-check', function (req, res) {
//     res.sendFile(path.join(__dirname, 'Autobe_Check.html'));
// });

// FTP Excel 백업 함수 (3개 시트로 구성)
async function backupAutobeDataToExcel(team, mcData, rpaData, joinedData) {
    const workbook = new ExcelJS.Workbook();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    
    // 대문자 팀명을 소문자로 매핑
    const teamMapping = {
        'A-TEAM': 'a-team',
        'B-TEAM': 'b-team', 
        'C-TEAM': 'c-team'
    };
    
    const scheduleKey = teamMapping[team] || team;
    const schedule = teamSchedules[scheduleKey];
    const timeStr = `${schedule.hour.toString().padStart(2, '0')}${schedule.minute.toString().padStart(2, '0')}`;
    const fileName = `Autobe_${team.toUpperCase()}_${dateStr}_${timeStr}.xlsx`;
    
    try {
        // Sheet 1: MC 장비 상태 (날짜, 시간 컬럼 제외)
        const mcSheet = workbook.addWorksheet('MC장비상태');
        mcSheet.columns = [
            { header: '장비ID', key: 'eqp_id', width: 15 },
            { header: '상태구분', key: 'status_seg', width: 10 },
            { header: '상태코드', key: 'status_code', width: 10 },
            { header: '사용자ID', key: 'user_id', width: 15 },
            { header: '코멘트', key: 'event_comment', width: 30 }
        ];
        mcSheet.addRows(mcData);

        // Sheet 2: RPA 작업 이력
        const rpaSheet = workbook.addWorksheet('RPA작업이력');
        rpaSheet.columns = [
            { header: '장비ID', key: 'eqp_id', width: 15 },
            { header: 'RPA시간', key: 'rpa_only_time', width: 15 },
            { header: 'LOT_ID', key: 'lot_id', width: 20 },
            { header: 'DEVICE_ID', key: 'device_id', width: 20 },
            { header: '진행상태', key: 'progress', width: 15 },
            { header: 'RPA상태', key: 'rpa_status', width: 15 },
            { header: '에러메시지', key: 'error_me', width: 30 },
            { header: '액션코멘트', key: 'action_comment', width: 30 }
        ];
        rpaSheet.addRows(rpaData);

        // Sheet 3: 조인 결과 (최종 모니터링 데이터)
        const joinSheet = workbook.addWorksheet('조인결과');
        joinSheet.columns = [
            { header: '장비ID', key: 'EQPID', width: 15 },
            { header: 'RPA시간', key: 'RPA_TIME', width: 15 },
            { header: 'LOT_ID', key: 'LOT_ID', width: 20 },
            { header: 'DEVICE_ID', key: 'DEVICE_ID', width: 20 },
            { header: '상태', key: 'STATUS', width: 10 },
            { header: '확인', key: 'CHECK_STATUS', width: 10 }
        ];
        
        // 데이터 추가 및 비정상 행 빨간색 음영 처리
        joinedData.forEach((item) => {
            // CHECK_STATUS 필드 초기화 (빈 값)
            const rowData = { ...item, CHECK_STATUS: '' };
            const row = joinSheet.addRow(rowData);
            
            // 비정상 장비인 경우 빨간색 배경색 적용
            if (item.STATUS === '비정상') {
                row.eachCell((cell) => {
                    cell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'FFFFE6E6' }  // 연한 빨간색 배경
                    };
                    cell.font = {
                        color: { argb: 'FF8B0000' }  // 진한 빨간색 글자
                    };
                });
            }
        });

        // 로컬 임시 파일로 저장
        const localPath = path.join(__dirname, fileName);
        await workbook.xlsx.writeFile(localPath);

        // FTP 업로드
        const client = new ftp.Client();
        client.ftp.verbose = true;
        client.ftp.pasv = true;

        try {
            await client.access({
                host: "192.168.223.23",
                user: "hyperauto",
                password: "Gkdlvj123!@#",
                secure: false
            });

            // FTP 경로 생성 (년/월/일 구조)
            const year = now.getFullYear();
            const month = (now.getMonth() + 1).toString().padStart(2, '0');
            const day = now.getDate().toString().padStart(2, '0');
            const remotePath = `RPA/Autobe_Backup/${year}/${month}/${day}/${fileName}`;
            
            // 디렉토리 생성 (존재하지 않으면)
            const remoteDir = `RPA/Autobe_Backup/${year}/${month}/${day}/`;
            try {
                await client.ensureDir(remoteDir);
            } catch (dirError) {
                console.log(`디렉토리 생성/확인: ${remoteDir}`);
            }

            // 파일 업로드 (파일명만 사용, 이미 올바른 디렉토리에 위치)
            await client.uploadFrom(localPath, fileName);
            console.log(`${team} Excel 백업 완료: ${remotePath}`);

        } catch (ftpError) {
            console.error(`${team} FTP 업로드 실패:`, ftpError);
            throw ftpError;
        } finally {
            client.close();
        }

        // 로컬 임시 파일 삭제
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }

        return fileName;

    } catch (error) {
        console.error(`${team} Excel 백업 오류:`, error);
        throw error;
    }
}

// Autobe 데이터 조회 함수 (조인결과만 사용)
async function fetchAutobeDataForTeam(team) {
    // 대문자 팀명을 소문자로 매핑
    const teamMapping = {
        'A-TEAM': 'a-team',
        'B-TEAM': 'b-team', 
        'C-TEAM': 'c-team'
    };
    
    const scheduleKey = teamMapping[team] || team;
    const schedule = teamSchedules[scheduleKey];
    if (!schedule) {
        throw new Error(`Unknown team: ${team}`);
    }
    
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        
        console.log(`${team} 조인결과 쿼리 실행 시작... (시간 필터: ${schedule.timeFilterStart} ~ ${schedule.timeFilterEnd})`);
        
        // 1. MC 장비 상태 데이터 조회 (Excel 백업용)
        const mcResult = await connection.execute(`
            SELECT
                eqp_id,
                TO_CHAR(TO_DATE(event_date,'YYYYMMDD HH24MISS'),'YYYY-MM-DD') only_date,
                TO_CHAR(TO_DATE(event_date,'YYYYMMDD HH24MISS'),'HH24:MI:SS') only_time,
                status_seg,
                status_code,
                user_id,
                event_comment
            FROM (
                SELECT
                    eqp_id,
                    event_date,
                    status_seg,
                    status_code,
                    user_id,
                    event_comment,
                    ROW_NUMBER() OVER (
                        PARTITION BY eqp_id
                        ORDER BY TO_DATE(event_date,'YYYYMMDD HH24MISS') DESC
                    ) rn
                FROM RPA_ADMIN.view_mc_eqp_hist
                WHERE eqp_id IN (
                    'T2K75','T2K76','T2K85','T2K94','T2K95','T2K98','T2K99','T2K100','T2K101','T2K102','T2K103','T2K104','T2K105','T2K106',
                    'UTS11','UTS12','UTS13','UTS14','UTS15','UTS16','UTS17','UTS18','UTS19','UTS20','UTS21','UTS22','UTS23','UTS24','UTS25','UTS26','UTS27','UTS28','UTS29','UTS30','UTS31','UTS32','UTS33','UTS34','UTS35','UTS36','UTS37','UTS38','UTS39','UTS40','UTS41','UTS42','UTS43','UTS44','UTS45','UTS46','UTS47','UTS48','UTS49','UTS50','UTS51','UTS52',
                    'UTC53','UTC54','UTC55','UTC56','UTC57','UTC58','UTC74','UTC75','UTC76','UTC77','UTC78','UTC79','UTC80','UTC81','UTC82','UTC83','UTC59','UTC60','UTC61','UTC62','UTC63','UTC64','UTC65','UTC66','UTC67','UTC68','UTC69','UTC70','UTC71','UTC72','UTC73',
                    'ND402','ND403','ND404','ND405','ND406','ND407','ND408','ND409','ND410','ND411','ND412','ND413','ND425','ND426','ND427','ND428','ND429','ND430','ND431','ND432','ND433','ND434','ND435','ND436','ND437','ND438','ND439','ND440',
                    'V93K01','V93K02','V93K03','V93K04','V93K05','V93K06','V93K07','V93K08','V93K09','V93K10','V93K11','V93K12',
                    'DMX02','DMX03','DMX04','DMX05','DMX06','DMX07','DMX08','DMX09','DMX10','DMX11','DMX12','DMX13','DMX14','DMX15','DMX16','DMX17','DMX18','DMX19','DMX20','DMX21'
                )
                AND status_seg = 'RUN'
                AND SUBSTR(event_date,1,8) = TO_CHAR(SYSDATE,'YYYYMMDD')
            )
            WHERE rn = 1
        `);
        
        // 2. RPA 작업 데이터 조회 (Excel 백업용)
        const rpaResult = await connection.execute(`
            SELECT
                eqp_id,
                TO_CHAR(start_time,'HH24:MI:SS') rpa_only_time,
                lot_id,
                device_id,
                progress,
                rpa_status,
                error_me,
                action_comment
            FROM (
                SELECT
                    eqp_id,
                    start_time,
                    lot_id,
                    device_id,
                    progress,
                    rpa_status,
                    error_me,
                    action_comment,
                    ROW_NUMBER() OVER (
                        PARTITION BY eqp_id
                        ORDER BY start_time DESC
                    ) rn
                FROM RPA_ADMIN.rpa
                WHERE TRUNC(start_time) = TRUNC(SYSDATE)
                AND TO_CHAR(start_time,'HH24:MI:SS') >= :timeFilterStart
                AND TO_CHAR(start_time,'HH24:MI:SS') <= :timeFilterEnd
            )
            WHERE rn = 1
        `, { 
            timeFilterStart: schedule.timeFilterStart,
            timeFilterEnd: schedule.timeFilterEnd
        });
        
        // 3. 조인 결과 조회 (UI용)
        const result = await connection.execute(`
            WITH a AS (
                SELECT
                    eqp_id,
                    TO_CHAR(TO_DATE(event_date,'YYYYMMDD HH24MISS'),'YYYY-MM-DD') only_date,
                    TO_CHAR(TO_DATE(event_date,'YYYYMMDD HH24MISS'),'HH24:MI:SS') only_time,
                    status_seg,
                    status_code,
                    user_id,
                    event_comment
                FROM (
                    SELECT
                        eqp_id,
                        event_date,
                        status_seg,
                        status_code,
                        user_id,
                        event_comment,
                        ROW_NUMBER() OVER (
                            PARTITION BY eqp_id
                            ORDER BY TO_DATE(event_date,'YYYYMMDD HH24MISS') DESC
                        ) rn
                    FROM RPA_ADMIN.view_mc_eqp_hist
                    WHERE eqp_id IN (
                        'T2K75','T2K76','T2K85','T2K94','T2K95','T2K98','T2K99','T2K100','T2K101','T2K102','T2K103','T2K104','T2K105','T2K106',
                        'UTS11','UTS12','UTS13','UTS14','UTS15','UTS16','UTS17','UTS18','UTS19','UTS20','UTS21','UTS22','UTS23','UTS24','UTS25','UTS26','UTS27','UTS28','UTS29','UTS30','UTS31','UTS32','UTS33','UTS34','UTS35','UTS36','UTS37','UTS38','UTS39','UTS40','UTS41','UTS42','UTS43','UTS44','UTS45','UTS46','UTS47','UTS48','UTS49','UTS50','UTS51','UTS52',
                        'UTC53','UTC54','UTC55','UTC56','UTC57','UTC58','UTC74','UTC75','UTC76','UTC77','UTC78','UTC79','UTC80','UTC81','UTC82','UTC83','UTC59','UTC60','UTC61','UTC62','UTC63','UTC64','UTC65','UTC66','UTC67','UTC68','UTC69','UTC70','UTC71','UTC72','UTC73',
                        'ND402','ND403','ND404','ND405','ND406','ND407','ND408','ND409','ND410','ND411','ND412','ND413','ND425','ND426','ND427','ND428','ND429','ND430','ND431','ND432','ND433','ND434','ND435','ND436','ND437','ND438','ND439','ND440',
                        'V93K01','V93K02','V93K03','V93K04','V93K05','V93K06','V93K07','V93K08','V93K09','V93K10','V93K11','V93K12',
                        'DMX02','DMX03','DMX04','DMX05','DMX06','DMX07','DMX08','DMX09','DMX10','DMX11','DMX12','DMX13','DMX14','DMX15','DMX16','DMX17','DMX18','DMX19','DMX20','DMX21'
                    )
                    AND status_seg = 'RUN'
                    AND SUBSTR(event_date,1,8) = TO_CHAR(SYSDATE,'YYYYMMDD')
                ) a_sub
                WHERE rn = 1
            ),
            b AS (
                SELECT
                    eqp_id,
                    TO_CHAR(start_time,'HH24:MI:SS') rpa_only_time,
                    lot_id,
                    device_id,
                    progress,
                    rpa_status,
                    error_me,
                    action_comment
                FROM (
                    SELECT
                        eqp_id,
                        start_time,
                        lot_id,
                        device_id,
                        progress,
                        rpa_status,
                        error_me,
                        action_comment,
                        ROW_NUMBER() OVER (
                            PARTITION BY eqp_id
                            ORDER BY start_time DESC
                        ) rn
                    FROM RPA_ADMIN.rpa
                    WHERE TRUNC(start_time) = TRUNC(SYSDATE)
                    AND TO_CHAR(start_time,'HH24:MI:SS') >= :timeFilterStart
                    AND TO_CHAR(start_time,'HH24:MI:SS') <= :timeFilterEnd
                ) b_sub
                WHERE rn = 1
            )
            SELECT
                a.eqp_id,
                b.rpa_only_time,
                b.lot_id,
                b.device_id,
                CASE 
                    WHEN b.eqp_id IS NOT NULL THEN '정상'
                    ELSE '비정상'
                END as status
            FROM a
            LEFT JOIN b
            ON a.eqp_id = b.eqp_id
            ORDER BY a.only_date DESC, a.only_time DESC
        `, { 
            timeFilterStart: schedule.timeFilterStart,
            timeFilterEnd: schedule.timeFilterEnd
        });
        
        console.log(`${team} 조인결과 쿼리 실행 완료`);
        console.log(`${team} 쿼리 결과 행 수: ${result.rows ? result.rows.length : 0}`);
        
        // 조인 결과 데이터 변환 (UI에서 사용)
        const joinedData = result.rows.map(row => ({
            EQPID: row[0],           // eqp_id (장비 ID)
            RPA_TIME: row[1],        // rpa_only_time (RPA 시간)
            LOT_ID: row[2],          // lot_id (LOT ID)
            DEVICE_ID: row[3],       // device_id (디바이스 ID)
            STATUS: row[4]           // status (정상/비정상)
        }));
        
        // MC 데이터 변환 (Excel 백업용)
        const mcData = mcResult.rows.map(row => ({
            eqp_id: row[0],
            only_date: row[1],
            only_time: row[2],
            status_seg: row[3],
            status_code: row[4],
            user_id: row[5],
            event_comment: row[6]
        }));
        
        // RPA 데이터 변환 (Excel 백업용)
        const rpaData = rpaResult.rows.map(row => ({
            eqp_id: row[0],
            rpa_only_time: row[1],
            lot_id: row[2],
            device_id: row[3],
            progress: row[4],
            rpa_status: row[5],
            error_me: row[6],
            action_comment: row[7]
        }));
        
        console.log(`${team} 매핑된 데이터 - MC: ${mcData.length}건, RPA: ${rpaData.length}건, 조인결과: ${joinedData.length}건`);
        
        return {
            joinedData: joinedData,  // UI에서 사용할 조인결과
            mcData: mcData,          // Excel 백업용 MC 데이터
            rpaData: rpaData         // Excel 백업용 RPA 데이터
        };
        
    } catch (error) {
        console.error(`${team} Autobe 데이터 조회 오류:`, error);
        throw error;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('DB 연결 종료 중 오류:', err);
            }
        }
    } 
}

// 조별 데이터 업데이트 함수
async function updateTeamData(team) {
    try {
        console.log(`=== ${team} 데이터 업데이트 시작 ===`);
        const dataResult = await fetchAutobeDataForTeam(team);
        
        // 캐시에 조인된 데이터 저장
        autobeDataCache[team] = {
            data: dataResult.joinedData,
            lastUpdate: new Date()
        };
        
        console.log(`=== ${team} 데이터 업데이트 완료: ${dataResult.joinedData.length}건 ===`);
        
        // Excel 백업 수행 (전체 데이터 백업)
        try {
            console.log(`=== ${team} Excel 백업 시작 ===`);
            const backupFileName = await backupAutobeDataToExcel(
                team,
                dataResult.mcData,
                dataResult.rpaData,  
                dataResult.joinedData
            );
            console.log(`=== ${team} Excel 백업 완료: ${backupFileName} ===`);
        } catch (backupError) {
            console.error(`${team} Excel 백업 실패:`, backupError);
            // 백업 실패해도 캐시 데이터는 유지
        }
        
    } catch (error) {
        console.error(`${team} 데이터 업데이트 실패:`, error);
        // 실패해도 빈 배열로 설정하여 시스템이 계속 작동하도록 함
        autobeDataCache[team] = {
            data: [],
            lastUpdate: new Date(),
            error: error.message
        };
    }
}

// Autobe 데이터 조회 API (캐시에서 반환)
app.get('/getAutobeData', async function (req, res) {
    const { team } = req.query;
    
    try {
        if (!team || !autobeDataCache[team]) {
            return res.status(400).json({ error: '유효하지 않은 팀입니다.' });
        }
        
        const cachedData = autobeDataCache[team];
        console.log(`${team} 캐시된 데이터 요청: ${cachedData.data.length}건`);
        
        res.json(cachedData.data);
        
    } catch (error) {
        console.error(`${team} 데이터 조회 오류:`, error);
        res.status(500).json({ 
            error: 'Autobe 데이터를 가져오는데 실패했습니다.', 
            details: error.message 
        });
    }
});

// 수동 업데이트 API (개발자 권한)
app.post('/refreshAutobeData', async function (req, res) {
    const { password, team } = req.body;
    
    try {
        // 비밀번호 검증
        if (password !== 'autobe2025!') {
            return res.status(401).json({ 
                success: false, 
                error: '올바르지 않은 비밀번호입니다.' 
            });
        }
        
        if (!team || !autobeDataCache[team]) {
            return res.status(400).json({ 
                success: false, 
                error: '유효하지 않은 팀입니다.' 
            });
        }
        
        console.log(`수동 업데이트 요청: ${team}`);
        
        // 해당 팀 데이터 즉시 업데이트
        await updateTeamData(team);
        
        const updatedData = autobeDataCache[team];
        
        res.json({
            success: true,
            message: `${team} 데이터가 성공적으로 업데이트되었습니다.`,
            dataCount: updatedData.data.length,
            lastUpdate: updatedData.lastUpdate
        });
        
    } catch (error) {
        console.error('수동 업데이트 오류:', error);
        res.status(500).json({
            success: false,
            error: '데이터 업데이트 중 오류가 발생했습니다.',
            details: error.message
        });
    }
});

// 스케줄러 설정 (내장 타이머 기반)
function setupSchedulers() {
    console.log('=== Autobe Check 스케줄러 초기화 (내장 타이머) ===');
    
    // 중복 실행 방지를 위한 변수
    let lastExecuted = {
        'a-team': null,
        'b-team': null,
        'c-team': null,
        'cache-clear': null
    };
    
    //test진행_2
    // 매분마다 시간을 체크하는 타이머 (60초마다)
    const schedulerInterval = setInterval(() => {
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        const currentDate = now.toDateString(); // 날짜별 실행 제어
        
        // A조: 매일 07:30
        if (currentTime === '07:30' && lastExecuted['a-team'] !== currentDate) {
            console.log('A조 스케줄 실행 (07:30)');
            updateTeamData('a-team').catch(err => console.error('A조 업데이트 실패:', err));
            lastExecuted['a-team'] = currentDate;
        }
        
        // B조: 매일 15:30
        if (currentTime === '15:30' && lastExecuted['b-team'] !== currentDate) {
            console.log('B조 스케줄 실행 (15:30)');
            updateTeamData('b-team').catch(err => console.error('B조 업데이트 실패:', err));
            lastExecuted['b-team'] = currentDate;
        }
        
        // C조: 매일 23:30
        if (currentTime === '23:30' && lastExecuted['c-team'] !== currentDate) {
            console.log('C조 스케줄 실행 (23:30)');
            updateTeamData('c-team').catch(err => console.error('C조 업데이트 실패:', err));
            lastExecuted['c-team'] = currentDate;
        }
        
        // 매일 00:01에 캐시 클리어
        if (currentTime === '00:01' && lastExecuted['cache-clear'] !== currentDate) {
            console.log('일일 캐시 클리어 (00:01)');
            autobeDataCache = {
                'a-team': { data: [], lastUpdate: null },
                'b-team': { data: [], lastUpdate: null },
                'c-team': { data: [], lastUpdate: null }
            };
            // 중복 실행 방지 변수도 초기화
            lastExecuted = {
                'a-team': null,
                'b-team': null,
                'c-team': null,
                'cache-clear': currentDate
            };
        }
        
    }, 60000); // 1분마다 체크 (메모리 효율성)
    
    // 개발/테스트용: 매분마다 실행 (필요시 주석 해제)
    // const testInterval = setInterval(() => {
    //     console.log('테스트 스케줄 실행 (매분)');
    //     updateTeamData('a-team').catch(err => console.error('테스트 업데이트 실패:', err));
    // }, 60000); // 1분마다
    
    console.log('내장 타이머 스케줄러 설정 완료:');
    console.log('- A조: 매일 07:30 (07:00~07:30 범위 데이터)');
    console.log('- B조: 매일 15:30 (15:00~15:30 범위 데이터)');
    console.log('- C조: 매일 23:30 (23:00~23:30 범위 데이터)');
    console.log('- Excel 백업: FTP 서버 자동 업로드');
    console.log('- 캐시 클리어: 매일 00:01');
    console.log('- 체크 간격: 1분');
    
    // 서버 종료 시 타이머 정리 (선택사항)
    process.on('SIGINT', () => {
        console.log('서버 종료 중... 스케줄러 타이머 정리');
        clearInterval(schedulerInterval);
        // if (testInterval) clearInterval(testInterval);
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log('서버 종료 중... 스케줄러 타이머 정리');
        clearInterval(schedulerInterval);
        // if (testInterval) clearInterval(testInterval);
        process.exit(0);
    });
}

