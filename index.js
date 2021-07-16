const { promisify } = require('util');
const { createServer } = require('http');
const { Server } = require('socket.io');
const redis = require('redis');
const redisAdapter = require('@socket.io/redis-adapter');
const jwtDecode = require('jwt-decode');

const PORT = process.env.PORT || 8080;

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const httpServer = createServer();
const io = new Server(httpServer, {
    cors: {
        origin: '*',
    },
});
httpServer.listen(PORT);

const pubClient = redis.createClient({
    host: REDIS_HOST,
    port: REDIS_PORT,
});
const subClient = pubClient.duplicate();
const redisClient = pubClient.duplicate();

const setValue = promisify(redisClient.set).bind(redisClient);
const getValue = promisify(redisClient.get).bind(redisClient);
const mGet = promisify(redisClient.mget).bind(redisClient);
const zAdd = promisify(redisClient.zadd).bind(redisClient);
const zIncrby = promisify(redisClient.zincrby).bind(redisClient);
const zRevrank = promisify(redisClient.zrevrank).bind(redisClient);
const zCard = promisify(redisClient.zcard).bind(redisClient);
const zRevrange = promisify(redisClient.zrevrange).bind(redisClient);
const ZMscore = promisify(redisClient.zmscore).bind(redisClient);

const getRangeUsers = async (min, max) => {
    if (min === max)
        return [];

    const userScores = await zRevrange(['user_money', min, max, 'WITHSCORES']);

    if (userScores.length < 1)
        return [];

    const userIds = [];
    const moneys = [];
    userScores.forEach((x, i) => {
        if (i % 2 === 0)
            userIds.push(x);
        else
            moneys.push(x);
    });

    const userTodayScores = await ZMscore(['user_today_money', ...userIds]);

    const users = (await mGet(userIds.map(x => `user_${x}`))).map(JSON.parse);
    let index = min;
    users.forEach((x, i) => {
        x.money = moneys[i];
        x.todayRank = userTodayScores[i];
        x.rank = index++;
    });

    return users;
};

const getTop100 = async () => {
    return await getRangeUsers(0, 99);
};

io.adapter(redisAdapter(pubClient, subClient));

io.on('connection', async (socket) => {
    let user;
    try {
        user = jwtDecode(socket.handshake.headers['authorization']);
    }
    catch (e) {
        console.log('Hatalı oturum anahtarı gönderimi');
        socket.disconnect();
    }

    try {
        const redisUser = await zRevrank(['user_money', user.id]);
        if (redisUser === null) {
            await zAdd(['user_money', 0, user.id]);
            const rank = await zRevrank(['user_money', user.id]);
            await zAdd(['user_today_money', rank, user.id])

            await setValue(`user_${user.id}`, JSON.stringify({
                id: user.id,
                name: user.name,
                country: user.country,
            }));
        }
    }
    catch (e) {
        console.log('Veritabanı işleminde hata oluştu', e);
        socket.disconnect();
    }

    const gameScore = async () => {
        const top100 = await getTop100();

        const currentRank = await zRevrank(['user_money', user.id]);

        let bottomList = await getRangeUsers(currentRank - 3, currentRank + 2);

        // ilk 100 içerisinde olan elemanlar çıkarılıyor
        for (let i = 5; i >= 0; i--) {
            if (!bottomList[i])
                continue;

            if (top100.find(x => x.id === bottomList[i].id) !== undefined) {
                bottomList = bottomList.slice(i+1);
                break;
            }
        }

        const result = [
            ...top100,
            ...bottomList,
        ];

        // TODO bir öncekinin aynısı ise dönülmeyecek

        socket.emit('score', result);

        return result;
    };
    gameScore();

    const userInterval = setInterval(gameScore, 1000);

    // kişinin oyunu oynadıktan para kazandıran method
    socket.on('end-game', async (money = 1) => {
        try {
            await zIncrby(['user_money', money, user.id]);

            // kişiye hemen dön
            await gameScore();
        }
        catch (e) {
            console.log(user, 'kişisinin parası yatırılamadı', e);
        }
    });

    socket.on('disconnect', () => {
        clearInterval(userInterval);
    })

});
