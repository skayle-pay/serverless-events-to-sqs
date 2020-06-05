const Joi = require("@hapi/joi");

const arn = Joi.alternatives().try(
	Joi.string().regex(/^arn:aws/, "ARN"),
	Joi.object().keys({
		Ref: Joi.string()
	}),
	Joi.object().keys({
		"Fn::GetAtt": Joi.array().items(Joi.string())
	}),
	Joi.object().keys({
		"Fn::ImportValue": Joi.alternatives().try(Joi.string(), Joi.object())
	}),
	Joi.object().keys({
		"Fn::Sub": Joi.alternatives().try(Joi.string(), Joi.array().length(2))
	})
);

const sns = Joi.alternatives().try(
	arn,
	Joi.object({
		logicalId: Joi.string(),
		displayName: Joi.string().required(),
		topicName: Joi.string()
	})
);

const snsEvent = Joi.object({
	sns: sns.required(),
	rawMessageDelivery: Joi.bool(),
	filterPolicy: Joi.object(), 
});


const eventBridgeEvent = Joi.object({
	eventBus: Joi.string().required(),
	pattern: Joi.object()
});

const source = Joi.alternatives().try(
	snsEvent,
	eventBridgeEvent
).match("one");

const sqsQueue = Joi.object({
	logicalId: Joi.string(),
	queueName: Joi.string().required(),
	delaySeconds: Joi.number()
		.min(0)
		.max(900),
	visibilityTimeout: Joi.number()
		.min(0)
		.max(43200),
	maximumMessageSize: Joi.number()
		.min(1024)
		.max(262144),
	messageRetentionPeriod: Joi.number()
		.min(60)
		.max(1209600)
});

const sqs = Joi.alternatives().try(
	arn,
	sqsQueue.keys({
		dlq: sqsQueue.keys({
			maxReceiveCount: Joi.number().min(1)
		})
	})
);

const schema = Joi.object({
	source: source.required(),
	sqs: sqs.required(),
	batchSize: Joi.number()
		.min(1)
		.max(10)
});

module.exports = schema;
