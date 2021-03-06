/* eslint global-require: 0 */
/* eslint no-process-exit: 0 */

'use strict'

const AmqpStats = require('amqp-stats')
const _ = require('lodash')
const debug = require('debug')('loopback:component:mq')
const loopback = require('loopback')
const url = require('url')
const rabbit = require('rabbot')
const modelDef = require('./models/rabbitmq.json')

function setupRabbitMqModel(app, settings) {
  // Assign ACLs from the component configuration.
  modelDef.acls = _.get(settings, 'options.acls', [])

  // Create the model.
  const RabbitMQ = loopback.createModel(modelDef)

  // Apply model customizations.
  require('./models/rabbitmq')(RabbitMQ)

  // Register the model.
  app.model(RabbitMQ)

  return loopback.getModel('RabbitMQ')
}

module.exports = function loopbackComponentMq(app, settings) {
  settings = settings || {}

  debug('initializing message queue component with settings: %O', settings)

  // Set up the RabbitMQ model.
  const RabbitMQ = setupRabbitMqModel(app, settings)

  // Make the configured logger available.
  RabbitMQ.log = _.get(settings, 'options.log', console)
  RabbitMQ.log = typeof RabbitMQ.log === 'string' ? require(RabbitMQ.log) : RabbitMQ.log

  // Handle the case where unable to connect to Rabbit.
  rabbit.on('unreachable', () => {
    RabbitMQ.log.error('Unable to connect to Rabbit')
    process.exit(1)
  })

  // Graceful shutdown.
  process.on('SIGINT', () => {
    debug('Caught SIGINT - performing graceful shutdown...')
    rabbit.shutdown()
    process.exit(1)
  })

  // Determine which queues should be subscribed to.
  const queuesToSubscribeTo = []

  _.map(settings.topology.queues, queue => {
    if (queue.subscribe) {
      queuesToSubscribeTo.push(queue)
      delete queue.subscribe
    }
  })

  // Start subscriptions for a list of queues.
  function startSubscriptionsForQueues(queues) {
    queues.forEach(queue => rabbit.startSubscription(queue.name))
    debug('Started subscriptions for queues: %O', queuesToSubscribeTo)
  }

  // Configure the rabbit topology.
  function configureRabbit() {
    return rabbit.configure(settings.topology)
      .then(() => debug('Rabbit topology configured'))
      .catch(err => {
        RabbitMQ.log.error('Unable to configure Rabbit topology', err)
        process.exit(1)
      })
  }

  // Start subscriptions for a list of queues.
  function startSubscriptions() {
    if (app.booting) {
      return app.on('booted', () => {
        startSubscriptionsForQueues(queuesToSubscribeTo)
      })
    }
    return startSubscriptionsForQueues(queuesToSubscribeTo)
  }

  function configureAmqpStats() {
    const connection = _.get(rabbit, 'configurations.default.connection')
    const parsedConnectionUri = url.parse(connection.uri)
    const ampqStatsOptions = {
      username: connection.user,
      password: connection.pass,
      hostname: `${parsedConnectionUri.hostname}:${_.get(settings, 'options.restPort', 15672)}`,
      protocol: (parsedConnectionUri.protocol === 'amqps') ? 'https' : 'http',
    }

    debug('Setting up AmqpStats with options: %o', ampqStatsOptions)

    // Set up access to AmqpStats.
    RabbitMQ.amqpStats = new AmqpStats(ampqStatsOptions)
  }

  configureRabbit()
    .then(() => configureAmqpStats())
    .then(() => startSubscriptions())
}
