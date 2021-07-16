const { promisify } = require('util');
const { createServer } = require('http');
const { Server } = require('socket.io');
const redis = require('redis');
const redisAdapter = require('@socket.io/redis-adapter');
const jwtDecode = require('jwt-decode');

const ScoreService = require('./ScoreService');

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

ScoreService.redisInit(redisClient);

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
        await ScoreService.checkUserAndCreate(user);
    }
    catch (e) {
        console.log('Veritabanı işleminde hata oluştu', e);
        socket.disconnect();
    }

    const gameScore = async () => {
        const result = await ScoreService.gameScore(user.id);

        // TODO bir öncekinin aynısı ise dönülmeyecek
        socket.emit('score', result);

        return result;
    };
    gameScore();

    const userInterval = setInterval(gameScore, 1000);

    // kişinin oyunu oynadıktan para kazandıran method
    socket.on('end-game', async (money = 1) => {
        try {
            await ScoreService.endGame(user.id, money);

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
