const {
    Client,
    Events,
    GatewayIntentBits
} = require('discord.js');

const {
    guildId,
    studyChannelIds,
    reportChannelId
} = require('./config.json');

const db = require('./database.js');


// ======================================================
// Discord 봇 생성
// ======================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});


// ======================================================
// 초 → 시간 / 분 / 초 변환
// ======================================================

function formatTime(totalSeconds) {

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${hours}시간 ${minutes}분 ${seconds}초`;
}


// ======================================================
// 특정 기간의 공부시간 계산
// ======================================================

function getStudyTimeBetween(userId, rangeStart, rangeEnd) {

    // 지정된 기간과 겹치는 공부 세션 조회
    const sessions = db.prepare(`
        SELECT *
        FROM study_sessions
        WHERE user_id = ?
          AND start_time < ?
          AND (
              end_time IS NULL
              OR end_time > ?
          )
    `).all(
        userId,
        rangeEnd,
        rangeStart
    );


    let totalSeconds = 0;


    for (const session of sessions) {

        // 세션 시작 시간이 조회 기간보다 이전이면
        // 조회 기간 시작 시각부터 계산
        const start = Math.max(
            session.start_time,
            rangeStart
        );


        // 아직 공부 중이면 현재 시각을 임시 종료 시각으로 사용
        const actualEnd =
            session.end_time ?? Date.now();


        // 조회 기간을 넘어가는 시간은 제외
        const end = Math.min(
            actualEnd,
            rangeEnd
        );


        if (end > start) {

            totalSeconds += Math.floor(
                (end - start) / 1000
            );

        }

    }


    return totalSeconds;
}


// ======================================================
// 전날 공부시간 자동 정산
// ======================================================

async function sendDailyReport() {

    const now = new Date();


    // 오늘 00:00
    const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
        0
    ).getTime();


    // 어제 00:00
    const yesterdayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 1,
        0,
        0,
        0,
        0
    ).getTime();


    // 어제 공부 기록이 존재하는 사용자 조회
    const users = db.prepare(`
        SELECT DISTINCT
            user_id,
            username
        FROM study_sessions
        WHERE start_time < ?
          AND (
              end_time IS NULL
              OR end_time > ?
          )
    `).all(
        todayStart,
        yesterdayStart
    );


    const results = [];


    // 사용자별 공부시간 계산
    for (const user of users) {

        const seconds = getStudyTimeBetween(
            user.user_id,
            yesterdayStart,
            todayStart
        );


        if (seconds > 0) {

            results.push({
                userId: user.user_id,
                username: user.username,
                seconds: seconds
            });

        }

    }


    // 공부시간이 많은 순서대로 정렬
    results.sort(
        (a, b) => b.seconds - a.seconds
    );


    // 날짜 표시
    const yesterday = new Date(yesterdayStart);

    const dateText =
        `${yesterday.getFullYear()}년 ` +
        `${yesterday.getMonth() + 1}월 ` +
        `${yesterday.getDate()}일`;


    // 정산 메시지 생성
    let message =
        `📚 **${dateText} 이만큼 했어요**\n\n`;


    if (results.length === 0) {

        message += '공부를 안했는뎁쇼';

    } else {

        results.forEach((result, index) => {

            message +=
                `${index + 1}. ` +
                `<@${result.userId}> — ` +
                `${formatTime(result.seconds)}\n`;

        });

    }


    // 정산 결과를 보낼 채널 가져오기
    const channel = await client.channels.fetch(
        reportChannelId
    );


    if (!channel || !channel.isTextBased()) {

        console.error(
            '공부시간 인증 채널이 없는뎁쇼'
        );

        return;

    }


    // 정산 결과 전송
    await channel.send(message);


    console.log(
        `[내일도 공부해야지] ${dateText}`
    );
}


// ======================================================
// 봇 재시작 시 진행 중 세션 복구
// ======================================================

async function recoverStudySessions() {

    console.log('공부 세션 복구 중임...');


    // DB에서 아직 종료되지 않은 세션 조회
    const activeSessions = db.prepare(`
        SELECT *
        FROM study_sessions
        WHERE end_time IS NULL
    `).all();


    for (const session of activeSessions) {

        let foundInStudyChannel = false;


        // 봇이 참여하고 있는 서버 확인
        for (const guild of client.guilds.cache.values()) {

            try {

                const member = await guild.members.fetch(
                    session.user_id
                );


                const currentChannelId =
                    member.voice.channelId;


                // 실제로 공부방에 있는 경우
                if (
                    currentChannelId &&
                    studyChannelIds.includes(
                        currentChannelId
                    )
                ) {

                    foundInStudyChannel = true;
                    break;

                }

            } catch {

                continue;

            }

        }


        // 아직 공부방에 있으면 기존 세션 유지
        if (foundInStudyChannel) {

            console.log(
                `[세션 유지] ${session.username}`
            );

            continue;

        }


        // 공부방에 없다면 남아 있는 세션 종료
        const endTime = Date.now();

        const durationSeconds = Math.floor(
            (endTime - session.start_time) / 1000
        );


        db.prepare(`
            UPDATE study_sessions
            SET end_time = ?,
                duration_seconds = ?
            WHERE id = ?
        `).run(
            endTime,
            durationSeconds,
            session.id
        );


        console.log(
            `[세션 복구 종료] ` +
            `${session.username} - ` +
            `${durationSeconds}초`
        );

    }


    console.log('공부 세션 복구 완료했음요');
}


// ======================================================
// 매일 자정 자동 정산 예약
// ======================================================

function scheduleDailyReport() {

    const now = new Date();


    // 다음날 00:00 계산
    const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        0,
        0
    );


    // 현재부터 다음 자정까지 남은 시간
    const delay =
        nextMidnight.getTime() -
        now.getTime();


    console.log(
        `다음 자동 정산: ${nextMidnight.toLocaleString()}`
    );


    setTimeout(async () => {

        try {

            await sendDailyReport();

        } catch (error) {

            console.error(
                '정산 오류났는뎁쇼:',
                error
            );

        }


        // 다음날 자정 정산 다시 예약
        scheduleDailyReport();

    }, delay);
}


// ======================================================
// 봇 로그인 완료
// ======================================================

client.once(
    Events.ClientReady,
    async (readyClient) => {

        console.log(
            `Ready! Logged in as ${readyClient.user.tag}`
        );


        // 진행 중이던 공부 세션 복구
        await recoverStudySessions();


        // --------------------------------------------------
        // 글로벌 명령어 전부 삭제
        // (예전에 등록된 /공부시간, /정산테스트 등 글로벌 명령어 제거)
        // --------------------------------------------------

        try {

            await readyClient.application.commands.set([]);

            console.log(
                '글로벌 명령어 전부 삭제 완료'
            );

        } catch (error) {

            console.error(
                '글로벌 명령어 삭제 실패:',
                error
            );

        }


        // --------------------------------------------------
        // /공부시간 명령어 등록 (Guild 명령어로만 등록)
        // --------------------------------------------------

        try {

            const guild =
                await readyClient.guilds.fetch(guildId);


            await guild.commands.set([
                {
                    name: '공부시간',
                    description:
                        '오늘 공부 얼만큼 했드라...'
                }
            ]);


            console.log(
                '/공부시간 명령어 등록 완료'
            );

        } catch (error) {

            console.error(
                '명령어 등록 실패:',
                error
            );

        }


        // 자정 자동 정산 예약
        scheduleDailyReport();

    }
);


// ======================================================
// 슬래시 명령어 처리
// ======================================================

client.on(
    Events.InteractionCreate,
    async (interaction) => {

        // 슬래시 명령어가 아니면 무시
        if (!interaction.isChatInputCommand()) {
            return;
        }


        // --------------------------------------------------
        // /공부시간
        // --------------------------------------------------

        if (
            interaction.commandName ===
            '공부시간'
        ) {

            const userId =
                interaction.user.id;


            const now =
                new Date();


            // 오늘 00:00
            const todayStart = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate(),
                0,
                0,
                0,
                0
            ).getTime();


            // 오늘 누적 공부시간 계산
            const totalSeconds =
                getStudyTimeBetween(
                    userId,
                    todayStart,
                    Date.now()
                );


            // 사용자에게 결과 전송
            await interaction.reply(
                `📚 오늘 이만큼 함 ㄷㄷ: ` +
                `${formatTime(totalSeconds)}`
            );


            return;

        }

    }
);


// ======================================================
// 음성 채널 상태 변화 감지
// ======================================================

client.on(
    Events.VoiceStateUpdate,
    (oldState, newState) => {

        // 봇 계정은 공부시간 측정에서 제외
        if (newState.member?.user.bot) {
            return;
        }


        const oldChannelId =
            oldState.channelId;

        const newChannelId =
            newState.channelId;


        // 이전에 공부방에 있었는가?
        const wasStudying =
            studyChannelIds.includes(
                oldChannelId
            );


        // 현재 공부방에 있는가?
        const isStudying =
            studyChannelIds.includes(
                newChannelId
            );


        const userId =
            newState.member.user.id;

        const username =
            newState.member.user.username;


        // ==================================================
        // 공부 시작
        // ==================================================

        if (
            !wasStudying &&
            isStudying
        ) {

            // 이미 진행 중인 세션이 있는지 확인
            const existingSession =
                db.prepare(`
                    SELECT *
                    FROM study_sessions
                    WHERE user_id = ?
                      AND end_time IS NULL
                    ORDER BY id DESC
                    LIMIT 1
                `).get(userId);


            // 진행 중 세션이 없을 때만 새 세션 생성
            if (!existingSession) {

                db.prepare(`
                    INSERT INTO study_sessions (
                        user_id,
                        username,
                        start_time
                    )
                    VALUES (?, ?, ?)
                `).run(
                    userId,
                    username,
                    Date.now()
                );


                console.log(
                    `[공부 시작] ${username}`
                );

            }


            return;

        }


        // ==================================================
        // 공부 종료
        // ==================================================

        if (
            wasStudying &&
            !isStudying
        ) {

            // 현재 진행 중인 세션 조회
            const session =
                db.prepare(`
                    SELECT *
                    FROM study_sessions
                    WHERE user_id = ?
                      AND end_time IS NULL
                    ORDER BY id DESC
                    LIMIT 1
                `).get(userId);


            if (!session) {

                console.log(
                    `[경고] ${username}의 ` +
                    `진행 중인 공부 기록이 없습니다.`
                );

                return;

            }


            const endTime =
                Date.now();


            // 총 공부시간 계산
            const durationSeconds =
                Math.floor(
                    (
                        endTime -
                        session.start_time
                    ) / 1000
                );


            // DB에 종료 시간과 공부시간 저장
            db.prepare(`
                UPDATE study_sessions
                SET end_time = ?,
                    duration_seconds = ?
                WHERE id = ?
            `).run(
                endTime,
                durationSeconds,
                session.id
            );


            console.log(
                `[공부 종료] ` +
                `${username} - ` +
                `${durationSeconds}초`
            );


            return;

        }


        // ==================================================
        // 공부방 → 다른 공부방
        // ==================================================

        if (
            wasStudying &&
            isStudying &&
            oldChannelId !== newChannelId
        ) {

            // 세션은 종료하지 않음
            console.log(
                `[공부방 이동] ${username}`
            );

        }

    }
);


// ======================================================
// Discord 로그인
// ======================================================

client.login(
    process.env.DISCORD_TOKEN
);