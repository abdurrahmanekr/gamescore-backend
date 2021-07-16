const cron = require('node-cron');
const { promisify } = require('util');
const { Server } = require('socket.io');
const redis = require('redis');
const redisAdapter = require('@socket.io/redis-adapter');
const jwtDecode = require('jwt-decode');
const app = require('express')();

const RankService = require('./RankService');

const PORT = process.env.PORT || 8080;

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const server = app.use((req, res) => res.send('Hello All!'))
  .listen(PORT, () => console.log(`Listening on ${PORT}`));

const io = new Server(server, {
    cors: {
        origin: '*',
    },
});

const pubClient = redis.createClient(process.env.REDIS_URL || ({
    host: REDIS_HOST,
    port: REDIS_PORT,
}));
const subClient = pubClient.duplicate();
const redisClient = pubClient.duplicate();

RankService.redisInit(redisClient);

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
        await RankService.checkUserAndCreate(user);
    }
    catch (e) {
        console.log('Veritabanı işleminde hata oluştu', e);
        socket.disconnect();
    }

    let lastSendedScore = [];

    const gameScore = async () => {
        const result = await RankService.gameScore(user.id);

        // Değişiklik olmuşsa client'a dönüyor ki
        // gereksiz yere trafik oluşturmasın
        let changed = RankService.changesCheck(lastSendedScore, result);

        if (changed) {
            lastSendedScore = result;
            socket.emit('score', result);
        }

        return result;
    };
    gameScore();

    const userInterval = setInterval(gameScore, 1000);

    // kişinin oyunu oynadıktan para kazandıran method
    socket.on('end-game', async (money = 1) => {
        try {
            await RankService.endGame(user.id, money);

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

// Her gün çalışacak şekilde
// Ancak tek bir node'da çalışmalı
cron.schedule('0 0 * * *', () => {
    RankService.dailyRankCalc()
    .catch(console.log);
});


// Her hafta sonu çalışacak çalışacak şekilde
// Ancak tek bir node'da çalışmalı
cron.schedule('0 0 * * 0', () => {
    RankService.weeklyDistribution()
    .catch(console.log);
});

