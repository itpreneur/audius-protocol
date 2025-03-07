const Sequelize = require('sequelize')
const moment = require('moment-timezone')
const retry = require('async-retry')
const uuidv4 = require('uuid/v4')
const axios = require('axios')

const models = require('../models')
const {
  handleResponse,
  successResponse,
  errorResponseBadRequest,
  errorResponseServerError
} = require('../apiHelpers')
const { logger } = require('../logging')
const authMiddleware = require('../authMiddleware')
const {
  createTrackListenTransaction,
  getFeePayerKeypair,
  sendAndSignTransaction
} = require('../solana-client')
const config = require('../config.js')
const { getFeatureFlag, FEATURE_FLAGS } = require('../featureFlag')

function trimToHour(date) {
  date.setMinutes(0)
  date.setSeconds(0)
  date.setUTCMilliseconds(0)
  return date
}

const oneDayInMs = 24 * 60 * 60 * 1000
const oneWeekInMs = oneDayInMs * 7
const oneMonthInMs = oneDayInMs * 30
const oneYearInMs = oneMonthInMs * 12

// Limit / offset related constants
const defaultLimit = 100
const minLimit = 1
const maxLimit = 500
const defaultOffset = 0
const minOffset = 0

// Duration for listen tracking redis keys prior to expiry is 1 week (in seconds)
const redisTxTrackingExpirySeconds = oneWeekInMs / 1000

const getPaginationVars = (limit, offset) => {
  if (!limit) limit = defaultLimit
  if (!offset) offset = defaultOffset
  const boundedLimit = Math.min(Math.max(limit, minLimit), maxLimit)
  const boundedOffset = Math.max(offset, minOffset)
  return { limit: boundedLimit, offset: boundedOffset }
}

const parseTimeframe = (inputTime) => {
  switch (inputTime) {
    case 'day':
    case 'week':
    case 'month':
    case 'year':
    case 'millennium':
      break
    default:
      inputTime = undefined
  }

  // Allow default empty value
  if (inputTime === undefined) {
    inputTime = 'millennium'
  }
  return inputTime
}

const getTrackListens = async (
  idList,
  timeFrame = undefined,
  startTime = undefined,
  endTime = undefined,
  limit = undefined,
  offset = undefined
) => {
  if (idList !== undefined && !Array.isArray(idList)) {
    return errorResponseBadRequest(
      'Invalid id list provided. Please provide an array of track IDs'
    )
  }
  let boundariesRequested = false
  try {
    if (startTime !== undefined && endTime !== undefined) {
      startTime = Date.parse(startTime)
      endTime = Date.parse(endTime)
      boundariesRequested = true
    }
  } catch (e) {
    logger.error(e)
  }

  // Allow default empty value
  if (timeFrame === undefined) {
    timeFrame = 'millennium'
  }

  const dbQuery = {
    attributes: [
      [models.Sequelize.col('trackId'), 'trackId'],
      [
        models.Sequelize.fn(
          'date_trunc',
          timeFrame,
          models.Sequelize.col('hour')
        ),
        'date'
      ],
      [models.Sequelize.fn('sum', models.Sequelize.col('listens')), 'listens']
    ],
    group: ['trackId', 'date'],
    order: [[models.Sequelize.col('listens'), 'DESC']],
    where: {}
  }
  if (idList && idList.length > 0) {
    dbQuery.where.trackId = { [models.Sequelize.Op.in]: idList }
  }

  if (limit) {
    dbQuery.limit = limit
  }

  if (offset) {
    dbQuery.offset = offset
  }

  if (boundariesRequested) {
    dbQuery.where.hour = {
      [models.Sequelize.Op.gte]: startTime,
      [models.Sequelize.Op.lte]: endTime
    }
  }
  const listenCounts = await models.TrackListenCount.findAll(dbQuery)
  const output = {}
  for (let i = 0; i < listenCounts.length; i++) {
    const currentEntry = listenCounts[i]
    const values = currentEntry.dataValues
    const date = values.date.toISOString()
    const listens = parseInt(values.listens)
    currentEntry.dataValues.listens = listens
    const trackId = values.trackId
    if (!output.hasOwnProperty(date)) {
      output[date] = {}
      output[date].utcMilliseconds = values.date.getTime()
      output[date].totalListens = 0
      output[date].trackIds = []
      output[date].listenCounts = []
    }

    output[date].totalListens += listens
    if (!output[date].trackIds.includes(trackId)) {
      output[date].trackIds.push(trackId)
    }

    output[date].listenCounts.push(currentEntry)
    output[date].timeFrame = timeFrame
  }
  return output
}

const getTrendingTracks = async (idList, timeFrame, limit, offset) => {
  if (idList !== undefined && !Array.isArray(idList)) {
    return errorResponseBadRequest(
      'Invalid id list provided. Please provide an array of track IDs'
    )
  }

  const dbQuery = {
    attributes: [
      'trackId',
      [models.Sequelize.fn('sum', models.Sequelize.col('listens')), 'listens']
    ],
    group: ['trackId'],
    order: [
      [models.Sequelize.col('listens'), 'DESC'],
      [models.Sequelize.col('trackId'), 'DESC']
    ],
    where: {}
  }

  // If id list present, add filter
  if (idList) {
    dbQuery.where.trackId = { [models.Sequelize.Op.in]: idList }
  }

  const currentHour = trimToHour(new Date())
  switch (timeFrame) {
    case 'day': {
      const oneDayBefore = new Date(currentHour.getTime() - oneDayInMs)
      dbQuery.where.hour = { [models.Sequelize.Op.gte]: oneDayBefore }
      break
    }
    case 'week': {
      const oneWeekBefore = new Date(currentHour.getTime() - oneWeekInMs)
      dbQuery.where.hour = { [models.Sequelize.Op.gte]: oneWeekBefore }
      break
    }
    case 'month': {
      const oneMonthBefore = new Date(currentHour.getTime() - oneMonthInMs)
      dbQuery.where.hour = { [models.Sequelize.Op.gte]: oneMonthBefore }
      break
    }
    case 'year': {
      const oneYearBefore = new Date(currentHour.getTime() - oneYearInMs)
      dbQuery.where.hour = { [models.Sequelize.Op.gte]: oneYearBefore }
      break
    }
    case 'millennium': {
      dbQuery.where.hour = { [models.Sequelize.Op.gte]: new Date(0) }
      break
    }
    case undefined:
      break
    default:
      return errorResponseBadRequest(
        'Invalid time parameter provided, use day/week/month/year or no parameter'
      )
  }
  if (limit) {
    dbQuery.limit = limit
  }

  if (offset) {
    dbQuery.offset = offset
  }

  const listenCounts = await models.TrackListenCount.findAll(dbQuery)
  const parsedListenCounts = []
  const seenTrackIds = []
  listenCounts.forEach((elem) => {
    parsedListenCounts.push({
      trackId: elem.trackId,
      listens: parseInt(elem.listens)
    })
    seenTrackIds.push(elem.trackId)
  })

  return parsedListenCounts
}

/**
 * Generate the redis keys required for tracking listen submission vs success
 * @param {string} hour formatted as such - 2022-01-25T21:00:00.000Z
 */
const getTrackingListenKeys = (hour) => {
  return {
    submission: `listens-tx-submission::${hour}`,
    success: `listens-tx-success::${hour}`
  }
}

/**
 * Initialize a key that expires after a certain number of seconds
 * @param {Object} redis connection
 * @param {String} key that will be initialized
 * @param {number} seconds number of seconds after which the key will expire
 */
const initializeExpiringRedisKey = async (redis, key, expiry) => {
  const value = await redis.get(key)
  if (!value) {
    await redis.set(key, 0, 'ex', expiry)
  }
}

const TRACKING_LISTEN_SUBMISSION_KEY = 'listens-tx-submission-ts'
const TRACKING_LISTEN_SUCCESS_KEY = 'listens-tx-success-ts'

module.exports = function (app) {
  app.get(
    '/tracks/listen/solana/status',
    handleResponse(async (req, res) => {
      const redis = req.app.get('redis')
      const results = await redis.keys('listens-tx-*')
      // Expected percent success
      const { percent = 0.9, cutoffMinutes = 60 } = req.query
      const hourlyResponseData = {}
      // Example key format = listens-tx-success::2022-01-25T21:00:00.000Z
      for (const entry of results) {
        const split = entry.split('::')
        if (split.length >= 2) {
          const hourSuffix = split[1]
          const trackingRedisKeys = getTrackingListenKeys(hourSuffix)

          if (!hourlyResponseData.hasOwnProperty(hourSuffix)) {
            hourlyResponseData[hourSuffix] = {
              submission: Number(await redis.get(trackingRedisKeys.submission)),
              success: Number(await redis.get(trackingRedisKeys.success)),
              time: new Date(hourSuffix)
            }
          }
        }
      }

      // Clean up time series entries that are greater than 1 week old
      const oldestExpireMillis =
        Date.now() - redisTxTrackingExpirySeconds * 1000
      await redis.zremrangebyscore(
        TRACKING_LISTEN_SUBMISSION_KEY,
        0,
        oldestExpireMillis
      )
      await redis.zremrangebyscore(
        TRACKING_LISTEN_SUCCESS_KEY,
        0,
        oldestExpireMillis
      )

      const totalSuccessCount = await redis.zcount(
        TRACKING_LISTEN_SUCCESS_KEY,
        0,
        Number.MAX_SAFE_INTEGER
      )
      const totalSubmissionCount = await redis.zcount(
        TRACKING_LISTEN_SUBMISSION_KEY,
        0,
        Number.MAX_SAFE_INTEGER
      )
      const totalPercentSuccess =
        totalSubmissionCount === 0
          ? 1
          : totalSuccessCount / totalSubmissionCount
      // Sort response in descending time order
      const sortedHourlyData = Object.keys(hourlyResponseData)
        .sort((a, b) => new Date(b) - new Date(a))
        .map((key) => hourlyResponseData[key])

      // Calculate success of submissions before the cutoff
      const now = Date.now()
      const nowPlusEntropy = now + 9 // Account for the fact that each date has a random UUID appended to it
      const nowMinusCutoff = now - cutoffMinutes * 60 * 1000
      const recentSuccessCount = await redis.zcount(
        TRACKING_LISTEN_SUCCESS_KEY,
        nowMinusCutoff,
        nowPlusEntropy
      )
      const recentSubmissionCount = await redis.zcount(
        TRACKING_LISTEN_SUBMISSION_KEY,
        nowMinusCutoff,
        nowPlusEntropy
      )
      const recentSuccessPercent =
        recentSubmissionCount === 0
          ? 1
          : recentSuccessCount / recentSubmissionCount
      const recentInfo = {
        recentSubmissionCount,
        recentSuccessCount,
        recentSuccessPercent,
        cutoffTimestamp: trimToHour(new Date(nowMinusCutoff)).toISOString()
      }
      const resp = {
        totalPercentSuccess,
        totalSuccessCount,
        totalSubmissionCount,
        sortedHourlyData,
        recentInfo
      }
      if (recentSuccessPercent < percent) {
        return errorResponseBadRequest(resp)
      }
      return successResponse(resp)
    })
  )

  app.post(
    '/tracks/:id/listen',
    handleResponse(async (req, res) => {
      const libs = req.app.get('audiusLibs')
      const connection = libs.solanaWeb3Manager.connection
      const solanaWeb3 = libs.solanaWeb3Manager.solanaWeb3
      const redis = req.app.get('redis')
      const trackId = parseInt(req.params.id)
      const userId = req.body.userId
      if (!userId || !trackId) {
        return errorResponseBadRequest(
          'Must include user id and valid track id'
        )
      }

      const optimizelyClient = app.get('optimizelyClient')
      const isSolanaListenEnabled = getFeatureFlag(
        optimizelyClient,
        FEATURE_FLAGS.SOLANA_LISTEN_ENABLED_SERVER
      )
      const solanaListen =
        req.body.solanaListen || isSolanaListenEnabled || false
      const timeout = req.body.timeout || 60000

      const sendRawTransaction =
        req.body.sendRawTransaction ||
        getFeatureFlag(
          optimizelyClient,
          FEATURE_FLAGS.SOLANA_SEND_RAW_TRANSACTION
        ) ||
        false

      const currentHour = trimToHour(new Date())
      // Dedicated listen flow
      if (solanaListen) {
        const suffix = currentHour.toISOString()
        const entropy = uuidv4()

        // Example key format = listens-tx-success::2022-01-25T21:00:00.000Z
        const trackingRedisKeys = getTrackingListenKeys(suffix)
        await initializeExpiringRedisKey(
          redis,
          trackingRedisKeys.submission,
          redisTxTrackingExpirySeconds
        )
        await initializeExpiringRedisKey(
          redis,
          trackingRedisKeys.success,
          redisTxTrackingExpirySeconds
        )

        req.logger.info(
          `TrackListen tx submission, trackId=${trackId} userId=${userId}, ${JSON.stringify(
            trackingRedisKeys
          )}`
        )

        await redis.incr(trackingRedisKeys.submission)
        await redis.zadd(
          TRACKING_LISTEN_SUBMISSION_KEY,
          Date.now(),
          Date.now() + entropy
        )
        let location
        try {
          let clientIPAddress =
            (req.headers['x-forwarded-for'] || '').split(',').pop().trim() ||
            req.socket.remoteAddress
          if (clientIPAddress.startsWith('::ffff:')) {
            clientIPAddress = clientIPAddress.slice(7)
          }

          const url = `https://api.ipdata.co/${clientIPAddress}?api-key=${config.get(
            'ipdataAPIKey'
          )}`

          const locationResponse = (await axios.get(url)).data
          location = {
            city: locationResponse.city,
            region: locationResponse.region,
            country: locationResponse.country_name
          }
        } catch (e) {
          req.logger.info(`TrackListen location fetch failed: ${e}`)
          location = {}
        }

        try {
          const trackListenTransaction = await createTrackListenTransaction({
            validSigner: null,
            privateKey: config.get('solanaSignerPrivateKey'),
            userId: userId.toString(),
            trackId: trackId.toString(),
            source: 'relay',
            location,
            connection
          })
          const feePayerAccount = getFeePayerKeypair(false)
          let solTxSignature
          if (sendRawTransaction) {
            req.logger.info(
              `TrackListen tx submission, trackId=${trackId} userId=${userId} - sendRawTransaction`
            )
            solTxSignature = await sendAndSignTransaction(
              connection,
              trackListenTransaction,
              feePayerAccount,
              timeout,
              logger
            )
          } else {
            await retry(
              async () => {
                req.logger.info(
                  `TrackListen tx submission, trackId=${trackId} userId=${userId} - sendAndConfirmTransaction`
                )
                solTxSignature = await solanaWeb3.sendAndConfirmTransaction(
                  connection,
                  trackListenTransaction,
                  [feePayerAccount],
                  {
                    skipPreflight: false,
                    commitment: config.get('solanaTxCommitmentLevel'),
                    preflightCommitment: config.get('solanaTxCommitmentLevel')
                  }
                )
              },
              {
                // Retry function 3x by default
                // 1st retry delay = 500ms, 2nd = 1500ms, 3rd...nth retry = 8000 ms (capped)
                minTimeout: 500,
                maxTimeout: 8000,
                factor: 3,
                retries: 3,
                onRetry: (err, i) => {
                  if (err) {
                    req.logger.error(
                      `TrackListens tx retry error, trackId=${trackId} userId=${userId} : ${err}`
                    )
                  }
                }
              }
            )
          }

          req.logger.info(
            `TrackListen tx confirmed, ${solTxSignature} userId=${userId}, trackId=${trackId}, sendRawTransaction=${sendRawTransaction}`
          )

          // Increment success tracker
          await redis.incr(trackingRedisKeys.success)
          await redis.zadd(
            TRACKING_LISTEN_SUCCESS_KEY,
            Date.now(),
            Date.now() + entropy
          )
          return successResponse({
            solTxSignature
          })
        } catch (e) {
          return errorResponseServerError(
            `TrackListens tx error, trackId=${trackId} userId=${userId} : ${e}`
          )
        }
      }

      // TODO: Make all of this conditional based on request parameters
      const trackListenRecord = await models.TrackListenCount.findOrCreate({
        where: { hour: currentHour, trackId }
      })
      if (trackListenRecord && trackListenRecord[1]) {
        logger.info(`New track listen record inserted ${trackListenRecord}`)
      }
      await models.TrackListenCount.increment('listens', {
        where: { hour: currentHour, trackId: req.params.id }
      })

      // Clients will send a randomly generated string UUID for anonymous users.
      // Those listened should NOT be recorded in the userTrackListen table
      const isRealUser = typeof userId === 'number'
      if (isRealUser) {
        // Find / Create the record of the user listening to the track
        const [userTrackListenRecord, created] =
          await models.UserTrackListen.findOrCreate({
            where: { userId, trackId }
          })

        // If the record was not created, updated the timestamp
        if (!created) {
          await userTrackListenRecord.increment('count')
          await userTrackListenRecord.save()
        }
      }

      return successResponse({})
    })
  )

  /*
   * Return listen history for a given user
   *  tracks/history/
   *    - tracks w/ recorded listen event sorted by date listened
   *
   *  GET query parameters (optional):
   *    userId (int) - userId of the requester
   *    limit (int) - limits number of results w/ a max of 100
   *    offset (int) - offset results
   */
  app.get(
    '/tracks/history',
    handleResponse(async (req, res) => {
      const userId = parseInt(req.query.userId)
      const limit = isNaN(req.query.limit)
        ? 100
        : Math.min(parseInt(req.query.limit), 100)
      const offset = isNaN(req.query.offset) ? 0 : parseInt(req.query.offset)
      if (!userId) {
        return errorResponseBadRequest('Must include user id')
      }

      const trackListens = await models.UserTrackListen.findAll({
        where: { userId },
        order: [['updatedAt', 'DESC']],
        attributes: ['trackId', 'updatedAt'],
        limit,
        offset
      })

      return successResponse({
        tracks: trackListens.map((track) => ({
          trackId: track.trackId,
          listenDate: track.updatedAt
        }))
      })
    })
  )

  /*
   * Return track listen history grouped by a specific time frame
   *  tracks/listens/
   *    - all tracks, sorted by play count
   *
   *  tracks/listens/<time>
   *    - <time> - day, week, month, year
   *    - returns all track listen info for given time period, sorted by play count
   *
   *  POST body parameters (optional):
   *    limit (int) - limits number of results
   *    offset (int) - offset results
   *    start (string) - ISO time string, used to define the start time period for query
   *    end (string) - ISO time string, used to define the end time period for query
   *    start/end are BOTH required if filtering based on time
   *    track_ids - filter results for specific track(s)
   *
   *  GET query parameters (optional):
   *    limit (int) - limits number of results
   *    offset (int) - offset results
   *    start (string) - ISO time string, used to define the start time period for query
   *    end (string) - ISO time string, used to define the end time period for query
   *    start/end are BOTH required if filtering based on time
   *    id (array of int) - filter results for specific track(s)
   */
  app.post(
    '/tracks/listens/:timeframe*?',
    handleResponse(async (req, res, next) => {
      const body = req.body
      const idList = body.track_ids
      const startTime = body.startTime
      const endTime = body.endTime
      const time = parseTimeframe(req.params.timeframe)
      const { limit, offset } = getPaginationVars(body.limit, body.offset)
      const output = await getTrackListens(
        idList,
        time,
        startTime,
        endTime,
        limit,
        offset
      )
      return successResponse(output)
    })
  )

  app.get(
    '/tracks/listens/:timeframe*?',
    handleResponse(async (req, res) => {
      const idList = req.query.id
      const startTime = req.query.start
      const endTime = req.query.end
      const time = parseTimeframe(req.params.timeframe)
      const { limit, offset } = getPaginationVars(
        req.query.limit,
        req.query.offset
      )
      const output = await getTrackListens(
        idList,
        time,
        startTime,
        endTime,
        limit,
        offset
      )
      return successResponse(output)
    })
  )

  /*
   * Return aggregate track listen count with various parameters
   *  tracks/trending/
   *    - all tracks, sorted by play count
   *
   *  tracks/trending/<time>
   *    - <time> - day, week, month, year
   *    - returns all tracks for given time period, sorted by play count
   *
   *  POST body parameters (optional):
   *    limit (int) - limits number of results
   *    offset (int) - offset results
   *    track_ids (array of int) - filter results for specific track(s)
   *
   *  GET query parameters (optional):
   *    limit (int) - limits number of results
   *    offset (int) - offset results
   *    id (array of int) - filter results for specific track(s)
   */
  app.post(
    '/tracks/trending/:time*?',
    handleResponse(async (req, res) => {
      const time = req.params.time
      const body = req.body
      const idList = body.track_ids
      const { limit, offset } = getPaginationVars(body.limit, body.offset)
      const parsedListenCounts = await getTrendingTracks(
        idList,
        time,
        limit,
        offset
      )
      return successResponse({ listenCounts: parsedListenCounts })
    })
  )

  app.get(
    '/tracks/trending/:time*?',
    handleResponse(async (req, res) => {
      const time = req.params.time
      const idList = req.query.id
      const { limit, offset } = getPaginationVars(
        req.query.limit,
        req.query.offset
      )
      const parsedListenCounts = await getTrendingTracks(
        idList,
        time,
        limit,
        offset
      )

      return successResponse({ listenCounts: parsedListenCounts })
    })
  )

  /*
   * Gets the tracks and listen counts for a user.
   * Useful for populating views like "Heavy Rotation" which
   * require sorted lists of track listens for a given user.
   *
   * GET query parameters:
   *  limit: (optional) The number of tracks to fetch
   */
  app.get(
    '/users/listens/top',
    authMiddleware,
    handleResponse(async (req, res) => {
      const { blockchainUserId: userId } = req.user
      const { limit = 25 } = req.query

      const listens = await models.UserTrackListen.findAll({
        where: {
          userId: {
            [Sequelize.Op.eq]: userId
          }
        },
        order: [['count', 'DESC']],
        limit
      })

      return successResponse({
        listens
      })
    })
  )

  /*
   * Gets whether or not tracks have been listened to by a target user.
   * Useful in filtering out tracks that a user has already listened to.
   * Requires auth.
   *
   * GET query parameters:
   *  trackIdList: The ids of tracks to check
   */
  app.get(
    '/users/listens',
    authMiddleware,
    handleResponse(async (req, res) => {
      const { blockchainUserId: userId } = req.user
      const { trackIdList } = req.query

      if (!trackIdList || !Array.isArray(trackIdList)) {
        return errorResponseBadRequest('Please provide an array of track ids')
      }

      const listens = await models.UserTrackListen.findAll({
        where: {
          userId: {
            [Sequelize.Op.eq]: userId
          },
          trackId: {
            [Sequelize.Op.in]: trackIdList
          }
        }
      })

      const listenMap = listens.reduce((acc, listen) => {
        acc[listen.dataValues.trackId] = listen.dataValues.count
        return acc
      }, {})

      trackIdList.forEach((id) => {
        if (!(id in listenMap)) {
          listenMap[id] = 0
        }
      })

      return successResponse({
        listenMap
      })
    })
  )

  /**
   * Gets user listen records in bulk.
   *
   * GET query parameters:
   *  startTime (string) the start time to fetch listens from (in unix seconds format)
   *  limit (number) the number of records to fetch from each user listens and anonymous listens
   */
  app.get(
    '/listens/bulk',
    handleResponse(async (req, res) => {
      let { startTime, limit } = req.query
      if (!startTime || !limit) {
        return errorResponseBadRequest('Please provide a startTime and limit')
      }

      limit = parseInt(limit)
      if (!limit) {
        return errorResponseBadRequest(`Provided limit ${limit} not parseable`)
      }
      if (limit > 5000) {
        return errorResponseBadRequest(
          `Provided limit ${limit} too large (must be <= 5000)`
        )
      }

      let updatedAtMoment
      try {
        updatedAtMoment = moment.unix(startTime)
        if (!updatedAtMoment.isValid()) throw new Error()
      } catch (e) {
        return errorResponseBadRequest(
          `Provided startTime ${startTime} not parseable`
        )
      }

      const userListens = await models.UserTrackListen.findAll({
        attributes: { exclude: ['id'] },
        where: {
          updatedAt: { [models.Sequelize.Op.gt]: updatedAtMoment.toDate() }
        },
        order: [
          ['updatedAt', 'ASC'],
          ['trackId', 'ASC']
        ],
        limit
      })

      const anonListens = await models.TrackListenCount.findAll({
        attributes: [
          'trackId',
          ['listens', 'count'],
          ['hour', 'createdAt'],
          'updatedAt'
        ],
        where: {
          updatedAt: { [models.Sequelize.Op.gt]: updatedAtMoment.toDate() }
        },
        order: [
          ['updatedAt', 'ASC'],
          ['trackId', 'ASC']
        ],
        limit
      })

      const listens = [...userListens, ...anonListens]
        .sort((a, b) => {
          return moment(a.updatedAt) - moment(b.updatedAt)
        })
        .slice(0, limit)

      return successResponse({
        listens
      })
    })
  )
}
