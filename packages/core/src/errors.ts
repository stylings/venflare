import { Schema } from "effect";

export class RequestRejected extends Schema.TaggedError<RequestRejected>()("RequestRejected", {
  status: Schema.Number,
  message: Schema.String,
}) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class DiscordError extends Schema.TaggedError<DiscordError>()("DiscordError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  { message: Schema.String },
) {}

export type ApplicationError =
  | RequestRejected
  | DatabaseError
  | StorageError
  | DiscordError
  | ConfigurationError;
