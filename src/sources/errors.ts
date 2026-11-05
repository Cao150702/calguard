/** A failed source read can still contain successfully collected, validated items. */
export class PartialFetchError<T> extends AggregateError {
  readonly partialResults: T[];

  constructor(message: string, errors: unknown[], partialResults: T[]) {
    super(errors, message);
    this.name = "PartialFetchError";
    // A source must not mutate the returned collection through a late callback.
    this.partialResults = [...partialResults];
  }
}
