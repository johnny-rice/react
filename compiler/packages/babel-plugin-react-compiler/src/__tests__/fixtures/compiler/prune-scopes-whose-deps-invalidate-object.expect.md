
## Input

```javascript
import {useHook} from 'shared-runtime';

function Component(props) {
  const x = {};
  useHook(); // intersperse a hook call to prevent memoization of x
  x.value = props.value;

  const y = {x};

  return {y};
}

export const FIXTURE_ENTRYPOINT = {
  fn: Component,
  params: [{value: 'sathya'}],
};

```

## Code

```javascript
import { useHook } from "shared-runtime";

function Component(props) {
  const x = {};
  useHook();
  x.value = props.value;

  const y = { x };
  return { y };
}

export const FIXTURE_ENTRYPOINT = {
  fn: Component,
  params: [{ value: "sathya" }],
};

```
      
### Eval output
(kind: ok) {"y":{"x":{"value":"sathya"}}}