# Use Observables for the React request wrapper

The React UI currently performs requests with local `fetch` and Promise state, but comparison loading needs one reusable owner for loading, errors, retry, and latest-request-wins cancellation. We will add RxJS and make `Observable<T>` the public input of a reusable React `RequestWrapper`; the first adoption is limited to Snapshot comparison, while migrating unrelated requests remains separate future work.
