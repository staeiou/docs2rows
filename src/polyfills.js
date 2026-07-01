if (!Promise.try) {
  Promise.try = (fn, ...args) =>
    new Promise((resolve) => {
      resolve(fn(...args));
    });
}

if (!Promise.withResolvers) {
  Promise.withResolvers = () => {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  };
}

// Safari only gained async iteration of ReadableStream in 17.4. On Safari 17.2,
// ReadableStream.prototype[Symbol.asyncIterator] is undefined, so pdf.js's
// `for await (const value of this.streamTextContent(...))` in getTextContent()
// throws "undefined is not a function" and the whole PDF import fails. Install
// the standard async-iterator wrapper around a default reader.
if (
  typeof ReadableStream !== "undefined" &&
  typeof Symbol !== "undefined" &&
  Symbol.asyncIterator &&
  !ReadableStream.prototype[Symbol.asyncIterator]
) {
  const values = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (error) {
          reader.releaseLock();
          throw error;
        }
      },
      async return(value) {
        if (!preventCancel) {
          const cancelPromise = reader.cancel(value);
          reader.releaseLock();
          await cancelPromise;
        } else {
          reader.releaseLock();
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  };
  ReadableStream.prototype.values = values;
  ReadableStream.prototype[Symbol.asyncIterator] = values;
}
