# aws-logs-sink

Stream logs to AWS CloudWatch logs.

## CLI usage

Install globally:

```shell
npm install -g aws-logs-sink
```

Provide the log group name and stream name as arguments, and write to `stdin`:

```shell
echo "This is a test" | aws-logs-sink <log-group-name> <log-stream-name>
```

Of course a long running stream works too:

```shell
while true; do date; sleep 1; done | aws-logs-sink <log-group-name> <log-stream-name>
```

The log group and stream will be created if they don't exist. If the log stream already exists, its next sequence token will be queried, in order to be able to append to the stream.

CLI options:

| Option               | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| -f, --flush-interval | Flush to CloudWatch every X seconds (default: 1)                              |
| --tee                | Also print all input to stdout                                                |
| --eol                | Line termination character(s) (default: "\n" on Mac/Linux, "\r\n" on Windows) |
| --profile            | AWS profile to use. Setting environment variable AWS_PROFILE works too        |
| --region             | AWS region to use. Setting environment variable AWS_REGION works too          |

## Programmatic usage

Install locally:

```shell
npm install aws-logs-sink
```

```javascript
import awsLogsSink from "aws-logs-sink";

const writable = awsLogsSink({
  logGroupName: "<log-group-name>",
  logStreamName: "<log-stream-name>",
  flushInterval: 1, // optional, see table above
  tee: false, // optional, see table above
  eol: "\n", // optional, see table above
  profile: "default", // optional, see table above
  region: "eu-west-1", // optional, see table above
  client: new CloudWatchLogsClient({}), // optional, will be created if not provided
});

writable.write("Hello, world!");

// Or more fancy with a pipeline:

import * as stream from "stream";

const readable = new stream.Readable({ read: () => {} });
readable.push("Hello, world! From pipeline");
readable.push(null);

stream.pipeline(readable, writable, (err) => {
  err ? console.error(err) : console.log("Done writing to CloudWatch");
});
```

## Required AWS permissions

| Permission                | Required                                                                    |
| ------------------------- | --------------------------------------------------------------------------- |
| `logs:CreateLogGroup`     | Yes                                                                         |
| `logs:CreateLogStream`    | Yes                                                                         |
| `logs:PutLogEvents`       | Yes                                                                         |
| `logs:DescribeLogStreams` | Only if writing to an existing log stream, to query its next sequence token |
