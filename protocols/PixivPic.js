const pixivImg = require("pixiv-img");
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
sharp.cache(false);
const _ = require('lodash');
const childProcess = require('child_process');
const moment = require('moment');
const nzhcn = require('nzh/cn');

// 连接数据库
const knex = require('knex')({
    client: 'mysql2',
    connection: {
        host: secret.mysqlHost,
        user: secret.mysqlUser,
        password: secret.mysqlPassword,
        database: secret.mysqlDatabase
    }
});

async function initDatabase() {
    if (!(await knex.schema.hasTable('seen_list'))) {
        await knex.schema.createTable('seen_list', table => {
            table.increments('id').primary();
        });
    }

    if (!(await knex.schema.hasColumn('seen_list', 'group'))) {
        await knex.schema.table('seen_list', table => {
            table.string('group');
        });
    }
    if (!(await knex.schema.hasColumn('seen_list', 'illust_id'))) {
        await knex.schema.table('seen_list', table => {
            table.integer('illust_id').unsigned();
        });
    }
    if (!(await knex.schema.hasColumn('seen_list', 'date'))) {
        await knex.schema.table('seen_list', table => {
            table.dateTime('date');
        });
    }
}

const groupList = JSON.parse(fs.readFileSync('./protocols/PixivPic_group_list.json', 'utf8'));

let isInitialized = false;

(async function () {
    cleanUp();
    // 初始化数据库
    await initDatabase();

    isInitialized = true;
})();

// 计时器 每秒执行一次
// 当前小时
let curHours = moment().hours();
// 色图技能充能
const illustMaxCharge = 5;
const illustCD = 120;
const illustCharge = {};
const timer = setInterval(() => {
    const curMoment = moment();
    if (curHours != curMoment.hours()) {
        curHours = curMoment.hours();
        cleanUp();
        // 每天12点清理色图缓存、更新色图库
        if (curHours == 12) {
            updateIllusts();
        }
    }
    // 充能（区分每个群）
    for (const groupId in illustCharge) {
        const charge = illustCharge[groupId];
        if (charge.count < illustMaxCharge) {
            charge.cd--;
            if (charge.cd == 0) {
                charge.cd = illustCD;
                charge.count++;
            }
        }
    }
}, 1000);

function cleanUp() {
    const illustDir = fs.readdirSync(path.join(secret.tempPath, 'image'));
    for (const illustPath of illustDir) {
        fs.unlinkSync(path.join(secret.tempPath, 'image', illustPath));
    }
}

const tagList = [
    '着',
    '乳',
    'おっぱい', //欧派
    '魅惑', //可以匹配到魅惑的大腿、魅惑的乳沟
    '黒スト', //黑Stocking 黑丝袜简称
    '白スト', //白Stocking 白丝袜简称
    'ニーソ', //Knee socks 过膝袜简称
    'タイツ', //Tights 裤袜
    'パンスト', //Panty stocking 裤袜简称
    'ストッキング', //Stocking 丝袜
    'ルーズソックス', //Loose socks 泡泡袜
    '丝袜',
    '足',
    '尻',
    'ぱんつ', //Pants 胖次
    'パンツ', //Pants 胖次
    'パンティ', //Panty 内裤
    'パンチラ', //露内裤
    '縛',
    '束',
    'ロリ', //萝莉
    '幼女',
    '獣耳',
    '男の娘',
    'ちんちんの付いた美少女' //带把美少女
]

const charTagList = [
    'レム(リゼロ)', //蕾姆
    '初音ミク', //初音未来
    'サターニャ', //萨塔妮娅
    '胡桃沢=サタニキア=マクドウェル', //胡桃泽·萨塔妮基亚·麦克道威尔
    '時崎狂三'
]

function replaceRegexpChar(tag) {
    return tag.replace(/(?=[\(\)\=])/g, '\\');
}

function updateIllusts() {
    childProcess.fork('Pixiv_database.js', [tagList.join(',') + ',' + charTagList.join(), 'day', 0, 0, 7]);
}

async function searchIllust(recvObj, tags, opt) {
    let illustsQuery;
    let illust;

    if (tags) {
        let stringQuery = '';
        for (const tag of tags) {
            stringQuery += stringQuery ? ` or \`tags\` like \'%${tag}%\'` : `(\`tags\` like \'%${tag}%\'`;
        }
        if (recvObj.type != 1) {
            stringQuery = '\`rating\` not like \'r18%\' and ' + stringQuery;
        }
        stringQuery += ')';
        illustsQuery = knex('illusts').whereRaw(stringQuery);
    } else {
        if (recvObj.type == 1) {
            illustsQuery = knex('illusts');
        } else {
            illustsQuery = knex('illusts').where('rating', 'not like', 'r18%')
        }
    }
    if (!opt.resend) {
        if ((recvObj.type == 1 || recvObj.type == 3 || recvObj.type == 5 || recvObj.type == 6) && opt.num > 1000) {
            illustsQuery.where('total_bookmarks', '>=', opt.num);
        } else {
            const rand = 1 - Math.pow(1 - Math.random(), 2) * 20000;
            if (rand > 1000)
                illustsQuery.where('total_bookmarks', '>=', rand);
        }
    }

    if (!(recvObj.type == 1 || recvObj.type == 3 || recvObj.type == 5 || recvObj.type == 6) && recvObj != '') {
        if (opt.resend) {
            illust = (await knex('illusts')
                .whereExists(
                    knex.from(knex('seen_list').where('group', recvObj.group).orderBy('id', 'desc').limit(1).offset(opt.num - 1).as('seen'))
                    .whereRaw('illusts.id = seen.illust_id')
                ))[0];
        } else {
            illustsQuery.as('illusts');
            const curQuery = knex.from(illustsQuery)
                .whereNotIn(
                    'id',
                    knex.select('illust_id as id').from('seen_list').where('group', recvObj.group)
                )
            const count = (await curQuery.clone().count('* as count'))[0].count;
            const rand = 1 - Math.pow(1 - Math.random(), 2);
            illust = (await curQuery.limit(1).offset(parseInt(rand * count)))[0];
        }
    } else {
        const count = (await illustsQuery.clone().count('* as count'))[0].count;
        const rand = 1 - Math.pow(1 - Math.random(), 2);
        illust = (await illustsQuery.limit(1).offset(parseInt(rand * count)))[0];
    }

    if (!illust) return null;

    console.log('PixivPic:', illust.id, illust.title, moment(illust.create_date).format('YYYY-MM-DD, H:mm:ss'));

    // 没给标签也没有命中性癖标签，需要重新找一次
    if (!tags && !(new RegExp(tagList.join('|')).test(illust.tags))) {
        return searchIllust(recvObj, tags, opt);
    }

    return illust;
}

async function downloadIllust(illust, recvObj, opt) {
    try {
        const illustPath = path.join(secret.tempPath, 'image', 'illust_' + path.basename(illust.image_url));
        await pixivImg(illust.image_url, illustPath);
        if (!opt.resend && !(recvObj.type == 1 || recvObj.type == 3 || recvObj.type == 5 || recvObj.type == 6) && recvObj.group != '') {
            await knex('seen_list').insert({
                group: recvObj.group,
                illust_id: illust.id,
                date: moment().format()
            });
        }
        const sourceImg = sharp(illustPath);
        const sourceImgMetadata = await sourceImg.metadata();
        const waterMarkImg = sharp('watermark.png');
        const waterMarkImgMetadata = await waterMarkImg.metadata();
        const x = sourceImgMetadata.width - waterMarkImgMetadata.width - (parseInt(Math.random() * 5) + 6);
        const y = sourceImgMetadata.height - waterMarkImgMetadata.height - (parseInt(Math.random() * 5) + 6);
        const waterMarkBuffer = await waterMarkImg.extract({
            left: x < 0 ? -x : 0,
            top: y < 0 ? -y : 0,
            width: x < 0 ? waterMarkImgMetadata.width + x : waterMarkImgMetadata.width,
            height: y < 0 ? waterMarkImgMetadata.height + y : waterMarkImgMetadata.height
        }).toBuffer();
        const imgBuffer = await sourceImg
            .composite([{
                input: waterMarkBuffer,
                left: x < 0 ? 0 : x,
                top: y < 0 ? 0 : y
            }])
            .jpeg({
                quality: 100,
                chromaSubsampling: '4:4:4'
            })
            .toBuffer();
        fs.writeFileSync(illustPath, imgBuffer);
        return illustPath;
    } catch {
        return null
    }
}

module.exports = function (recvObj, client) {
    // 群黑名单
    if (groupList.block.indexOf(recvObj.group.toString()) != -1) {
        return false;
    }

    // 色图计数
    if (/((色|涩|瑟)图|图库)计数|总(数|计)/m.test(recvObj.content)) {
        (async function () {
            client.sendMsg(recvObj, '图库总计: ' + (await knex('illusts').where('tags', 'not like', '%r-18%').count('* as count'))[0].count + '张');
        })();
        return true;
    }
    // 获取数字
    let num; {
        const msg = recvObj.content.replace(/\[.*?\]/g, '').trim();
        num = parseInt(msg.match(/\d+/));
        if (!num) {
            const numZh = msg.match(/[零一二两三四五六七八九十百千万亿兆]+/);
            if (numZh)
                num = parseInt(nzhcn.decodeS(numZh.toString().replace(/两/g, '二')));
        }
    }
    // 重发
    if (/(重|重新|再)发/m.test(recvObj.content)) {
        PixivPic(recvObj, client, null, {
            resend: true,
            num: num || 1
        });
        return true;
    }
    // 十连or三连
    let autoBurst = false;
    let burstNum = 0;
    if ((recvObj.type == 1 || recvObj.type == 3 || recvObj.type == 5 || recvObj.type == 6) &&
        /(十|10)连/m.test(recvObj.content)) {
        autoBurst = true;
        burstNum = 10;
    } else if (/(三|3)连/m.test(recvObj.content)) {
        autoBurst = true;
        burstNum = 3;
    }
    // 胸
    if (/奶|乳|胸|欧派|咪咪/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['乳,おっぱい', '魅惑の谷間'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 黑丝
    else if (/黑丝/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['黒スト', '黒ニーソ', '黒タイツ'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 白丝
    else if (/白丝/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['白スト', '白ニーソ', '白タイツ'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 泡泡袜
    else if (/泡泡袜/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['ルーズソックス'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 吊带袜
    else if (/吊带袜|吊袜带/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['ガーターストッキング', 'ガーターベルト'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 其他丝袜
    else if (/袜/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['丝袜', 'タイツ,パンスト', 'ストッキング'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 大腿
    else if (/腿/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['魅惑のふともも'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 臀
    else if (/屁股|臀|屁屁/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['尻'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 足底
    else if (/(足|脚)底/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['足裏'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 足
    else if (/足|脚|jio/im.test(recvObj.content)) {
        PixivPic(recvObj, client, ['足'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 胖次
    else if (/胖次|内裤|小裤裤/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['ぱんつ', 'パンツ', 'パンティ', 'パンチラ'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 拘束
    else if (/拘|束|捆|绑|缚/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['拘束', '緊縛'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 萝莉
    else if (/萝莉|幼女|炼铜/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['ロリ', '幼女'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 兽耳
    else if (/兽耳|兽娘/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['獣耳'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 伪娘
    else if (/伪娘|女装|铝装|可爱的男|带把/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['男の娘', 'ちんちんの付いた美少女'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 蕾姆
    else if (/(蕾|雷)(姆|母)|rem/im.test(recvObj.content)) {
        PixivPic(recvObj, client, ['レム(リゼロ)'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 初音未来
    else if (/初音|初音未来|miku|hatsunemiku|hatsune miku|公主殿下/im.test(recvObj.content)) {
        PixivPic(recvObj, client, ['初音ミク'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    // 萨塔妮娅自己
    else if (/(萨|傻|撒)塔(妮|尼)(娅|亚)/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['サターニャ', '胡桃沢=サタニキア=マクドウェル'], {
            autoBurst,
            burstNum,
            num
        });
        return true;

    }
    // 時崎狂三
    else if (/狂三|时崎狂三|三三/m.test(recvObj.content)) {
        PixivPic(recvObj, client, ['時崎狂三'], {
            autoBurst,
            burstNum,
            num
        });
        return true;
    } else if (/(色|涩|瑟)图|gkd|搞快点|开车|不够(色|涩|瑟)/im.test(recvObj.content)) {
        PixivPic(recvObj, client, null, {
            autoBurst,
            burstNum,
            num
        });
        return true;
    }
    return false;
}

async function PixivPic(recvObj, client, tags, opt) {
    // N连抽
    if (opt.autoBurst) {
        opt.autoBurst = false;
        for (let i = 0; i < opt.burstNum; i++) {
            await PixivPic(recvObj, client, tags, opt);
        }
        return;
    }

    if (!isInitialized) {
        client.sendMsg(recvObj, '萨塔尼亚还没准备好~');
        return;
    }

    if (!illustCharge[recvObj.group]) {
        illustCharge[recvObj.group] = {
            count: illustMaxCharge,
            cd: illustCD
        }
    }
    // 白名单
    if (groupList.white.indexOf(recvObj.group.toString()) != -1) {
        illustCharge[recvObj.group].count = 99;
    }

    if (illustCharge[recvObj.group].count <= 0 && !opt) {
        client.sendMsg(recvObj, '搞太快了~ 请等待' +
            (parseInt(illustCharge[recvObj.group].cd / 60) == 0 ? '' : (parseInt(illustCharge[recvObj.group].cd / 60) + '分')) +
            illustCharge[recvObj.group].cd % 60 + '秒'
        );
        return;
    }

    let illustPath;
    try {
        const illust = await searchIllust(recvObj, tags, opt);
        if (!illust) throw 'illust is null';
        illustPath = await downloadIllust(illust, recvObj, opt);
    } catch {}

    if (illustPath) {
        illustCharge[recvObj.group].count--;
        client.sendMsg(recvObj, `[QQ:pic=${illustPath}]`);
    } else {
        client.sendMsg(recvObj, `[QQ:pic=${secret.emoticonsPath}\\satania_cry.gif]`);
    }
}