const _ = require("lodash");
const schema = require("./schema");

class ServerlessSnsToSqsEvents {
	constructor(serverless) {
		this.serverless = serverless;
		this.addToTemplate = (logicalId, resource) => {
			_.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, {
				[logicalId]: resource
			});
		};
		this.provider = this.serverless.getProvider("aws");
		this.log = msg => this.serverless.cli.log(`serverless-events-to-sqs plugin:\n${msg}`);
		this.verboseLog = msg => {
			if (process.env.SLS_DEBUG) {
				this.log(msg);
			}
		};
		this.error = error => {
			throw new this.serverless.classes.Error(`eventsToSqs event: ${error.message}`);
		};

		this.hooks = {
			"before:package:compileEvents": this.compileEventsToSqs.bind(this)
		};
	}

	isArn(input) {
		return _.isString(input) || input.Ref || input["Fn::GetAtt"] || input["Fn::ImportValue"] || input["Fn::Sub"];
	}

	getLogicalId(name, type) {
		const normalizedName = _.upperFirst(name.replace(/-/g, "Dash").replace(/_/g, "Underscore"));
		const suffix = _.upperFirst(type);
		return `${normalizedName}${suffix}`;
	}

	getDlq(dlqConfig) {
		if (!dlqConfig) {
			return {};
		}

		const dlq = this.createSqsQueue(dlqConfig);
		const dlqLogicalId = 
      dlqConfig.logicalId || this.getLogicalId(dlqConfig.queueName, "Queue");

		this.addToTemplate(dlqLogicalId, dlq);
		this.verboseLog(`added DLQ [${dlqConfig.queueName}] as [${dlqLogicalId}]`);

		const redrivePolicy = {
			maxReceiveCount: dlqConfig.maxReceiveCount,
			deadLetterTargetArn: {
				"Fn::GetAtt": [dlqLogicalId, "Arn"]
			}
		};

		return { dlq, redrivePolicy };
	}

	createSqsQueue(sqs, redrivePolicy) {
		this.verboseLog(`creating SQS queue: ${sqs.queueName}`);

		return {
			Type: "AWS::SQS::Queue",
			Properties: {
				DelaySeconds: sqs.delaySeconds,
				MaximumMessageSize: sqs.maximumMessageSize,
				MessageRetentionPeriod: sqs.messageRetentionPeriod,
				QueueName: sqs.queueName,
				RedrivePolicy: redrivePolicy,
				VisibilityTimeout: sqs.visibilityTimeout
			}
		};
	}

	getOrCreateSqsQueue({ sqs }) {
		if (this.isArn(sqs)) {
			return sqs;
		}

		const { redrivePolicy } = this.getDlq(sqs.dlq);

		const sqsQueue = this.createSqsQueue(sqs, redrivePolicy);
		const sqsQueueLogicalId =
      sqs.logicalId || this.getLogicalId(sqs.queueName, "Queue");

		this.addToTemplate(sqsQueueLogicalId, sqsQueue);
		this.verboseLog(`added SQS queue [${sqs.queueName}] as [${sqsQueueLogicalId}]`);

		return {
			"Fn::GetAtt": [sqsQueueLogicalId, "Arn"]
		};
	}

	getSqsUrl(sqsArn) {
		if (_.isString(sqsArn)) {
			// eslint-disable-next-line no-unused-vars
			const [_arn, _aws, _sqs, region, accountId, queueName] = sqsArn.split(":");
			return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
		} else if (sqsArn["Fn::GetAtt"]) {
			const logicalId = _.head(sqsArn["Fn::GetAtt"]);
			return {
				Ref: logicalId
			};
		} else {
			this.error(new Error("Unable to convert sqsArn to URL", sqsArn));
		}
	}

	createSnsTopic(sns) {
		return {
			Type: "AWS::SNS::Topic",
			Properties: {
				DisplayName: sns.displayName,
				TopicName: sns.topicName
			}
		};
	}

	getOrCreateSnsTopic({ sns }) {
		if (this.isArn(sns)) {
			return sns;
		}

		const snsTopic = this.createSnsTopic(sns);
		const snsTopicLogicalId =
      sns.logicalId || this.getLogicalId(sns.displayName, "Topic");

		this.addToTemplate(snsTopicLogicalId, snsTopic);
		this.verboseLog(`added SNS topic [${sns.topicName}] as [${snsTopicLogicalId}]`);

		return {
			Ref: snsTopicLogicalId
		};
	}

	getEventBusName({ eventBus }) {
		return eventBus;
	}

	createEventBusRule(sqsArn, eventBusName, { pattern }) {
		return {
			Type: "AWS::Events::Rule",
			Properties: {
				EventBusName: eventBusName,
				EventPattern: pattern,
				State: "ENABLED",
				Targets: [
					{
						Id: "sqs-queue",
						Arn: sqsArn
					}
				]
			}
		};
	}

	createSnsSubscription(sqsArn, snsArn, { rawMessageDelivery, filterPolicy }) {
		return {
			Type: "AWS::SNS::Subscription",
			Properties: {
				Protocol: "sqs",
				Endpoint: sqsArn,
				RawMessageDelivery: rawMessageDelivery,
				FilterPolicy: filterPolicy,
				TopicArn: snsArn
			}
		};
	}

	createSqsPolicy(sqsArn, sourceArn, sqsUrl) {
		return {
			Type: "AWS::SQS::QueuePolicy",
			Properties: {
				Queues: [sqsUrl],
				PolicyDocument: {
					Version: "2012-10-17",
					Statement: {
						Effect: "Allow",
						Principal: "*",
						Action: "sqs:SendMessage",
						Resource: sqsArn,
						Condition: {
							ArnEquals: {
								"aws:SourceArn": sourceArn
							}
						}
					}
				}
			}
		};
	}

	convertSqsArnToLogicalId(sqsArn) {
		if (_.isString(sqsArn)) {
			const queueName = _.last(sqsArn.split(":"));
			return this.getLogicalId(queueName, "Queue");
		} else if (sqsArn["Fn::GetAtt"]) {
			return _.head(sqsArn["Fn::GetAtt"]);
		} else {
			this.error(new Error("Unable to convert sqsArn to logical Id", sqsArn));
		}
	}

	convertSnsArnToLogicalId(snsArn) {
		if (_.isString(snsArn)) {
			const snsName = _.last(snsArn.split(":"));
			return this.getLogicalId(snsName, "Topic");
		} else if (snsArn.Ref) {
			return snsArn.Ref;
		} else if (snsArn["Fn::ImportValue"]) {
			return this.getLogicalId(snsArn["Fn::ImportValue"], "Topic");
		} else {
			this.error(new Error("Unable to convert snsArn to logical Id", snsArn));
		}
	}

	getEventBusRuleLogicalId(functionName, sqsArn, eventBusName) {
		const prefix = this.provider.naming.getLambdaLogicalId(functionName);
		const sqsId = this.convertSqsArnToLogicalId(sqsArn);
		const eventBusId = this.getLogicalId(eventBusName, "EventBus");;

		return `${prefix}${eventBusId}To${sqsId}Rule`;
	}

	getSnsSubscriptionLogicalId(functionName, sqsArn, snsArn) {
		const prefix = this.provider.naming.getLambdaLogicalId(functionName);
		const sqsId = this.convertSqsArnToLogicalId(sqsArn);
		const snsId = this.convertSnsArnToLogicalId(snsArn);

		return `${prefix}${snsId}To${sqsId}Subscription`;
	}

	getSqsPolicyLogicalId(functionName, sqsArn, snsArn) {
		const prefix = this.provider.naming.getLambdaLogicalId(functionName);
		const sqsId = this.convertSqsArnToLogicalId(sqsArn);
		const snsId = this.convertSnsArnToLogicalId(snsArn);

		return `${prefix}${snsId}To${sqsId}QueuePolicy`;
	}

	compileEventsToSqs() {
		this.serverless.service.getAllFunctions().forEach(functionName => {
			const functionObj = this.serverless.service.getFunction(functionName);

			if (functionObj.events) {
				const sqsEvents = [];
				functionObj.events.forEach(event => {
					if (event.eventsToSqs) {
						const { value, error } = schema.validate(event.eventsToSqs);
						if (error) {
							this.error(error);
						}

						const sqsArn = this.getOrCreateSqsQueue(value);
						const sqsUrl = this.getSqsUrl(sqsArn);
            
						if (value.source.eventBus) {
							const eventBusName = this.getEventBusName(value.source);
							const eventBusRule = this.createEventBusRule(sqsArn, eventBusName, value.source);
							const eventBusRuleLogicalId = this.getEventBusRuleLogicalId(functionName, sqsArn, eventBusName);
							this.addToTemplate(eventBusRuleLogicalId, eventBusRule);
							this.verboseLog(`added EventBus rule: ${eventBusRule}`);

							const ruleArn = {"Fn::GetAtt": [eventBusRuleLogicalId, "Arn"]};
							const sqsPolicy = this.createSqsPolicy(sqsArn, ruleArn, sqsUrl);
							const sqsPolicyLogicalId = this.getSqsPolicyLogicalId(functionName, sqsArn, eventBusName);
							this.addToTemplate(sqsPolicyLogicalId, sqsPolicy);
							this.verboseLog(`added SQS queue policy: ${sqsPolicy}`);
						} else if (value.source.sns) {
							const snsArn = this.getOrCreateSnsTopic(value.source);
							const snsSubscription = this.createSnsSubscription(sqsArn, snsArn, value.source);
							const snsSubscriptionLogicalId = this.getSnsSubscriptionLogicalId(functionName, sqsArn, snsArn);
							this.addToTemplate(snsSubscriptionLogicalId, snsSubscription);
							this.verboseLog(`added SNS subscription: ${snsSubscription}`);

							const sqsPolicy = this.createSqsPolicy(sqsArn, snsArn, sqsUrl);
							const sqsPolicyLogicalId = this.getSqsPolicyLogicalId(functionName, sqsArn, snsArn);
							this.addToTemplate(sqsPolicyLogicalId, sqsPolicy);
							this.verboseLog(`added SQS queue policy: ${sqsPolicy}`);
						}

						sqsEvents.push({
							sqs: {
								arn: sqsArn,
								batchSize: value.batchSize
							}
						});
					}
				});

				sqsEvents.forEach(evt => functionObj.events.push(evt));
			}
		});
	}
}

module.exports = ServerlessSnsToSqsEvents;
