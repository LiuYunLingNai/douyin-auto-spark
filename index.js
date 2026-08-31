import chalk from 'chalk'
import Ver from './components/Version.js'
import { DouyinAutoSpark } from './apps/douyin.js'
import { DouyinAutoSparkUpdate } from './apps/update.js'

logger.info(chalk.rgb(253, 235, 255)('----ヾ(￣▽￣)Bye~Bye~----'))
logger.info(chalk.rgb(134, 142, 204)(`抖音续火插件${Ver.ver}初始化~`))
logger.info(chalk.rgb(253, 235, 255)('-------------------------'))

export const apps = {
  douyin: DouyinAutoSpark,
  update: DouyinAutoSparkUpdate,
}
