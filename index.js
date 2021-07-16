const { promisify } = require('util');
const { createServer } = require('http');
const { Server } = require('socket.io');
const redis = require('redis');
const redisAdapter = require('@socket.io/redis-adapter');
const { MongoClient } = require('mongodb');
const jwtDecode = require('jwt-decode');

const PORT = process.env.PORT || 8080;

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const MONGO_HOST = process.env.MONGO_HOST || 'localhost';
const MONGO_PORT = process.env.MONGO_PORT || 27017;
const MONGO_DBNAME = process.env.MONGO_DBNAME || 'gamescore';
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || 'users';

const httpServer = createServer();
const io = new Server(httpServer, {
    cors: {
        origin: '*',
    },
});
httpServer.listen(PORT);

let mongoDb, collection;

const mongoConnection = async () => {
    const client = new MongoClient(`mongodb://${MONGO_HOST}:${MONGO_PORT}`);
    await client.connect();

    mongoDb = client.db(MONGO_DBNAME);
    collection = mongoDb.collection(MONGO_COLLECTION);

    // cache'i yeniden yükle
    getTop100(true);
};

mongoConnection()
.catch(err => {
    console.error('Mongodb bağlantısı kurulamadı');
    throw err;
});

const pubClient = redis.createClient({
    host: REDIS_HOST,
    port: REDIS_PORT,
});
const subClient = pubClient.duplicate();
const redisClient = pubClient.duplicate();

const getValue = promisify(redisClient.get).bind(redisClient);
const setValue = promisify(redisClient.set).bind(redisClient);

const query = [{
    '$sort': {
        money: -1
    }
}, {
    '$group': {
        '_id': false,
        'users': {
            '$push': {
                '_id': '$_id',
                'id': '$id',
                'name': '$name',
                'country': '$country',
                'money': '$money'
            }
        }
    }
}, {
    '$unwind': {
        'path': '$users',
        'includeArrayIndex': 'rank'
    }
}];

const getTop100 = async (goDb = false) => {
    const top100 = JSON.parse(await getValue('get_top_100'));

    if (goDb || top100 === null) {
        // TODO redis'e ekle
        return await collection.aggregate(query.concat([{
            '$project': {
                'id': '$users.id',
                'name': '$users.name',
                'country': '$users.country',
                'money': '$users.money',
                'rank': '$rank',
            }
        }])).limit(100).toArray();
    }

    return top100;
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
        const dbUser = await collection.findOne({ id: user.id });
        if (dbUser == null) {
            await collection.insertOne({
                id: user.id,
                name: user.name,
                country: user.country,
                money: 0,
            });
            await setValue(`user_${user.id}_money`, 0);
        }
    }
    catch (e) {
        console.log('Veritabanı işleminde hata oluştu', e);
        socket.disconnect();
    }

    const gameScore = async () => {
        const top100 = await getTop100();

        let currentMoney = parseInt(await getValue(`user_${user.id}_money`));
        if (isNaN(currentMoney)) {
            currentMoney = (await collection.findOne({ id: user.id })).money;
        }

        const currentRank = (await collection.aggregate(query.concat([{
            '$match': {
                'users.id': user.id
            },
        }])).toArray())[0].rank;

        let bottomList = await collection.aggregate(query.concat([{
            '$match': {
                'rank': {
                    '$in': [currentRank+2, currentRank+1, currentRank, currentRank-1, currentRank-2, currentRank-3],
                },
            },
        }, {
            '$project': {
                'id': '$users.id',
                'name': '$users.name',
                'country': '$users.country',
                'money': '$users.money',
                'rank': '$rank',
            }
        }])).toArray();

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

        socket.emit('score', result);
    };
    gameScore();

    const userInterval = setInterval(gameScore, 1000);

    // kişinin oyunu oynadıktan para kazandıran method
    socket.on('end-game', async (money = 1) => {
        try {
            const top100 = await getTop100();
            const oldMoney = parseInt(await getValue(`user_${user.id}_money`));
            const newMoney = (oldMoney || 0) + money;

            await setValue(`user_${user.id}_money`, newMoney);
            await collection.updateOne({ id: user.id }, { '$set': { money: newMoney, } });

            // top 100 değişmiştir cache'i yenile
            if (top100.find(x => x.id === user.id || x.money < newMoney)) {
                await getTop100(true);
            }

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
