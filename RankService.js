const { promisify } = require('util');

let setValue, getValue, delValue, mGet, zAdd, zIncrby, zRevrank, zCard, zRevrange, zMscore;
class RankService {
    redisInit(redisClient) {
        setValue = promisify(redisClient.set).bind(redisClient);
        getValue = promisify(redisClient.get).bind(redisClient);
        delValue = promisify(redisClient.del).bind(redisClient);
        mGet = promisify(redisClient.mget).bind(redisClient);
        zAdd = promisify(redisClient.zadd).bind(redisClient);
        zIncrby = promisify(redisClient.zincrby).bind(redisClient);
        zRevrank = promisify(redisClient.zrevrank).bind(redisClient);
        zCard = promisify(redisClient.zcard).bind(redisClient);
        zRevrange = promisify(redisClient.zrevrange).bind(redisClient);
        zMscore = promisify(redisClient.zmscore).bind(redisClient);
    }

    async getRangeUsers(min, max) {
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

        const userTodayScores = await zMscore(['user_today_money', ...userIds]);

        const users = (await mGet(userIds.map(x => `user_${x}`))).map(JSON.parse);
        let index = min;
        users.forEach((x, i) => {
            x.money = moneys[i];
            x.todayRank = userTodayScores[i];
            x.rank = index++;
        });

        return users;
    }

    async getTop100() {
        return await this.getRangeUsers(0, 99);
    }

    async checkUserAndCreate(user) {
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

    async gameScore(userId) {
        const top100 = await this.getTop100();

        const currentRank = await zRevrank(['user_money', userId]);

        let bottomList = await this.getRangeUsers(currentRank - 3, currentRank + 2);

        // ilk 100 i??erisinde olan elemanlar ????kar??l??yor
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

        return result;
    }

    async endGame(userId, money) {
        return await zIncrby(['user_money', money, userId]);
    }

    changesCheck(before, after) {
        if (after.length !== before.length) {
            return true;
        }

        for (let i = 0; i < after.length; i++) {
            for (let j in after[i]) {
                if (after[i][j] !== before[i][j]) {
                    return true;
                }
            }
        }

        return false;
    }

    // Haftal??k da????t??m i??ini yapan i??lem
    async weeklyDistribution() {
        const allMoneys = await zRevrange(['user_money', 0, -1, 'WITHSCORES']);
        let total = 0;
        allMoneys.forEach((x, i) => {
            if (i % 2 === 1) {
                total += parseInt(x);
            }
        })

        // para yoksa ekmek yok :)
        if (total === 0)
            return;

        const distributedMoney = total * 0.02;
        const firstUser = distributedMoney * 0.2;
        const secondUser = distributedMoney * 0.15;
        const thirdUser = distributedMoney * 0.1;

        const leftMoney = Math.floor((distributedMoney - firstUser - secondUser - thirdUser) / 97);

        const top100 = await this.getTop100();

        await zIncrby(['user_money', Math.floor(firstUser), top100[0].id]);
        await zIncrby(['user_money', Math.floor(secondUser), top100[1].id]);
        await zIncrby(['user_money', Math.floor(thirdUser), top100[2].id]);

        // ki??i ba???? da????lam??yorsa kimseye adil bir ??ekilde kimseye da????lmas??na gerek yok
        if (leftMoney > 0) {
            await Promise.all(new Array(97).fill().map((x, i) => ((async () => {
                await zIncrby(['user_money', leftMoney, top100[97 - i].id]);
            })())));
        }

        console.log('Haftal??k para da????tma bitti');

        await delValue(['user_money']);
        await delValue(['user_today_money']);

        console.log('Score Tablosu s??f??rland??');
    }

    async dailyRankCalc() {
        const ranks = await zRevrange(['user_money', 0, -1]);

        await Promise.all(ranks.map((x, i) => ((async () => {
            await zAdd(['user_today_money', i, x]);
        })())))

        console.log('G??nl??k score kaydetme tamamland??')
    }
}

module.exports = new RankService();