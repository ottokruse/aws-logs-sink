#!/usr/bin/env node

import * as stream from "stream";
import * as os from "os";
import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DescribeLogStreamsCommand,
  InputLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

const logger = {
  debug: (...args: unknown[]) => {
    process.env.DEBUG && console.debug("[aws-logs-sink] DEBUG", ...args);
  },
  error: (...args: unknown[]) => {
    console.error("[aws-logs-sink] ERROR", ...args);
  },
};

async function ensureLogGroup(config: {
  client: CloudWatchLogsClient;
  logGroupName: string;
}) {
  const { client, logGroupName } = config;
  try {
    await client.send(
      new CreateLogGroupCommand({
        logGroupName,
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "ResourceAlreadyExistsException")
      throw err;
    return false;
  }
  return true;
}

async function ensureLogStream(config: {
  client: CloudWatchLogsClient;
  logGroupName: string;
  logStreamName: string;
}) {
  const { client, logGroupName, logStreamName } = config;
  try {
    await client.send(
      new CreateLogStreamCommand({
        logGroupName,
        logStreamName,
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "ResourceAlreadyExistsException")
      throw err;
    return false;
  }
  return true;
}

async function getLogStreamSequenceToken(config: {
  client: CloudWatchLogsClient;
  logGroupName: string;
  logStreamName: string;
}) {
  const { client, logGroupName, logStreamName } = config;
  const { logStreams } = await client.send(
    new DescribeLogStreamsCommand({
      logGroupName,
      logStreamNamePrefix: logStreamName,
    })
  );
  if (!logStreams) {
    throw new Error(
      `Failed to query log stream ${logGroupName}/${logStreamName}`
    );
  }
  return logStreams[0].uploadSequenceToken;
}

function cloudWatchInit(config: {
  logGroupName: string;
  logStreamName: string;
  client: CloudWatchLogsClient;
}) {
  const logStreamExists = Promise.resolve()
    .then(() => ensureLogGroup(config))
    .then(() => ensureLogStream(config));
  let forwardChunk = (chunk: unknown, cb: stream.TransformCallback) => {
    logStreamExists
      .then(() => {
        forwardChunk = (chunk, cb) => cb(null, chunk);
        cb(null, chunk);
      })
      .catch(cb);
  };
  return new stream.Transform({
    transform: function (chunk, _encoding, cb) {
      forwardChunk(chunk, cb);
    },
    construct: function (cb) {
      logStreamExists.catch((err) => {
        this.destroy(err as Error);
      });
      cb();
    },
  });
}

export default function sink(config: {
  logGroupName: string;
  logStreamName: string;
  tee?: boolean;
  flushInterval?: number;
  profile?: string;
  region?: string;
  client?: CloudWatchLogsClient;
  eol?: string;
}) {
  if (config.profile) {
    process.env.AWS_PROFILE = config.profile;
  }
  const client =
    config.client ??
    new CloudWatchLogsClient({
      region: config.region,
    });
  const pipelineHead = cloudWatchInit({ ...config, client });
  stream.pipeline(
    pipelineHead,
    assembleLines(config.eol),
    cloudWatchLogsSink({ ...config, client }),
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    () => {}
  );
  return pipelineHead;
}

function cloudWatchLogsSink(config: {
  client: CloudWatchLogsClient;
  logGroupName: string;
  logStreamName: string;
  tee?: boolean;
  flushInterval?: number;
}) {
  const buffer: {
    message: string;
    timestamp: number;
  }[] = [];
  let flushTimer: ReturnType<typeof setInterval>;
  let sequenceToken: PutLogEventsCommand["input"]["sequenceToken"];
  let flushingBuffer: Promise<null> = Promise.resolve(null);

  async function flushBufferToCloudWatchLogs() {
    await flushingBuffer;
    flushingBuffer = doFlushBufferToCloudWatchLogs();
    return flushingBuffer;
  }

  async function doFlushBufferToCloudWatchLogs() {
    let logEvents: typeof buffer;
    while ((logEvents = buffer.splice(0, 1000)).length) {
      sequenceToken = await sendLogsToCloudWatch({
        ...config,
        logEvents,
        sequenceToken,
      });
    }
    return null;
  }

  return new stream.Writable({
    construct: function (cb) {
      flushTimer = setInterval(() => {
        flushBufferToCloudWatchLogs().catch((err) =>
          this.destroy(err as Error)
        );
      }, config.flushInterval ?? 1000);
      cb();
    },
    destroy: function (err, cb) {
      clearInterval(flushTimer);
      cb(err);
    },
    final: function (cb) {
      flushBufferToCloudWatchLogs().then(cb).catch(cb);
    },
    writev: function (chunks, cb) {
      for (const { chunk } of chunks) {
        const text = (chunk as { toString(): string }).toString();
        if (config.tee) {
          console.info(text);
        }
        if (text) {
          buffer.push({
            message: text,
            timestamp: Date.now(),
          });
        }
      }
      cb();
    },
  });
}

async function doSendLogstoCloudWatch(props: {
  client: CloudWatchLogsClient;
  logGroupName: string;
  logStreamName: string;
  logEvents: InputLogEvent[];
  sequenceToken?: string;
}) {
  const { client, logGroupName, logStreamName, sequenceToken, logEvents } =
    props;
  const { nextSequenceToken } = await client.send(
    new PutLogEventsCommand({
      logEvents,
      logGroupName: logGroupName,
      logStreamName: logStreamName,
      sequenceToken,
    })
  );
  return nextSequenceToken;
}

async function sendLogsToCloudWatch(props: {
  client: CloudWatchLogsClient;
  logGroupName: string;
  logStreamName: string;
  logEvents: InputLogEvent[];
  sequenceToken?: string;
}) {
  try {
    return await doSendLogstoCloudWatch(props);
  } catch (err) {
    if (
      [
        "DataAlreadyAcceptedException",
        "InvalidSequenceTokenException",
      ].includes((err as { name?: string }).name ?? "__no_name_in_error__")
    ) {
      logger.debug("Syncing sequenceToken, was:", props.sequenceToken);
      const sequenceToken = await getLogStreamSequenceToken(props);
      logger.debug("New sequenceToken is:", sequenceToken);
      return await doSendLogstoCloudWatch({ ...props, sequenceToken });
    } else {
      throw err;
    }
  }
}

function assembleLines(eol = os.EOL) {
  const eolAsBuffer = Buffer.from(eol);
  const empty = Buffer.alloc(0);
  let buffered = empty;
  return new stream.Transform({
    transform: function (chunk: Buffer, _encoding, cb) {
      const concatenated = Buffer.concat([buffered, chunk]);
      if (
        Buffer.compare(
          eolAsBuffer,
          concatenated.slice(concatenated.length - eolAsBuffer.length)
        ) === 0 // check if chunk ends with EOL
      ) {
        // chunk ends with EOL, i.e. a complete message
        this.push(concatenated);
        buffered = empty;
      } else {
        // chunk does not end with EOL, i.e. not a complete message, wait for additional chunk
        buffered = concatenated;
      }
      cb();
    },
    final: function (cb) {
      if (buffered.length) {
        this.push(buffered);
      }
      cb();
    },
  });
}

if (require.main === module) {
  const args = yargs(hideBin(process.argv))
    .command(
      "$0 <log-group-name> <log-stream-name> [Options]",
      "Stream logs from stdin to AWS CloudWatch logs."
    )
    .string("log-group-name")
    .string("log-stream-name")
    .number("flush-interval")
    .alias("f", "flush-interval")
    .describe("f", "Flush to CloudWatch every X seconds")
    .default("f", 1)
    .boolean("tee")
    .describe("tee", "Also print all input to stdout")
    .string("eol")
    .describe("eol", "Line termination character(s)")
    .default("eol", os.EOL, JSON.stringify(os.EOL))
    .string("profile")
    .describe("profile", "AWS profile to use")
    .string("region")
    .describe("region", "AWS region to use")
    .demandCommand()
    .parseSync();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const logGroupName = args["log-group-name"]!;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const logStreamName = args["log-stream-name"]!;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const flushInterval = args["flush-interval"]!;
  const { tee, region, profile, eol } = args;

  const _sink = sink({
    logGroupName,
    logStreamName,
    flushInterval,
    tee,
    profile,
    region,
    eol,
  });

  stream.pipeline(process.stdin, _sink, exit);
}

function exit(err?: Error | null) {
  if (err) {
    logger.error(err);
    process.exit(1);
  }
  logger.debug("Completed successfully");
}
