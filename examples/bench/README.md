# js-framework-benchmark app

This app is the keyed gg entry for [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark).

## Run

1. Run `npm run build-prod` here.
2. Copy `index.html`, `package.json` and `dist` to `frameworks/keyed/gg` of a benchmark checkout, and set both scripts in the copy to `exit 0`.
3. In the checkout, run `npm start`, then `npm run bench -- --headless --framework keyed/gg keyed/vanillajs`.
4. Results go to `webdriver-ts/results`.

## Results

These results come from gg 0.3.0 on 2026-11-15, on an Apple M4 Pro, headless Chrome of puppeteer, and 15 runs for each CPU test.
Each value is a median in ms, and the number in brackets is the slowdown against the fastest entry.
The gg rows of update10th1k_x16, select1k and swap1k come from a later run, after rows began to keep an unchanged label.
The versions are solid 1.9, svelte 5.42, vue 3.5, inferno 10, lit 3, preact 11 and react 19.

| bench               |           gg |    vanillajs |        solid |       svelte |          vue |      inferno |          lit | preact-hooks |  react-hooks |
| ------------------- | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| run1k               |  29.5 (1.35) |  21.9 (1.00) |  23.5 (1.07) |  22.7 (1.04) |  24.6 (1.12) |  22.7 (1.04) |  24.6 (1.12) |  26.5 (1.21) |  25.9 (1.18) |
| replace1k           |  30.2 (1.30) |  23.3 (1.00) |  25.4 (1.09) |  26.7 (1.15) |  27.1 (1.17) |  23.2 (1.00) |  26.0 (1.12) |  30.4 (1.31) |  30.4 (1.31) |
| update10th1k_x16    |  18.4 (1.51) |  12.2 (1.00) |  12.5 (1.02) |  14.3 (1.17) |  15.1 (1.24) |  13.1 (1.07) |  14.0 (1.15) |  23.4 (1.92) |  16.6 (1.36) |
| select1k            |   4.8 (1.04) |   5.6 (1.22) |   7.3 (1.59) |   5.6 (1.22) |   4.8 (1.04) |   4.6 (1.00) |   6.1 (1.33) |  14.8 (3.22) |   6.3 (1.37) |
| swap1k              |  23.9 (1.80) |  13.3 (1.00) |  15.2 (1.14) |  15.8 (1.19) |  16.0 (1.20) |  14.0 (1.05) |  18.1 (1.36) |  26.5 (1.99) |  94.8 (7.13) |
| remove-one-1k       |  11.1 (1.04) |  10.7 (1.00) |  13.8 (1.29) |  11.5 (1.07) |  13.8 (1.29) |  12.8 (1.20) |  12.1 (1.13) |  16.3 (1.52) |  14.6 (1.36) |
| create10k           | 302.8 (1.40) | 216.6 (1.00) | 234.6 (1.08) | 235.7 (1.09) | 252.8 (1.17) | 240.8 (1.11) | 260.4 (1.20) | 281.6 (1.30) | 357.3 (1.65) |
| create1k-after1k_x2 |  32.4 (1.32) |  24.5 (1.00) |  25.9 (1.06) |  25.9 (1.06) |  27.7 (1.13) |  27.1 (1.11) |  28.9 (1.18) |  31.0 (1.27) |  29.3 (1.20) |
| clear1k_x8          |  15.0 (1.46) |  11.8 (1.15) |  11.9 (1.16) |  12.0 (1.17) |  17.2 (1.67) |  10.3 (1.00) |  15.1 (1.47) |  13.9 (1.35) |  18.8 (1.83) |
| **CPU geomean**     |         1.34 |         1.04 |         1.16 |         1.13 |         1.22 |         1.06 |         1.22 |         1.59 |         1.67 |
| ready memory MB     |          0.7 |          0.6 |          0.6 |          0.7 |          0.9 |          0.6 |          0.7 |          0.6 |          1.2 |
| run memory MB       |          3.8 |          1.9 |          2.7 |          2.9 |          3.9 |          2.6 |          2.8 |          3.3 |          4.4 |
| run-clear memory MB |          1.3 |          0.7 |          0.8 |          1.0 |          1.2 |          0.8 |          0.9 |          0.8 |          2.0 |
| size KB             |         37.4 |         11.3 |         11.5 |         26.6 |         64.3 |         28.1 |         22.1 |         14.8 |        190.3 |
| size gzip KB        |         13.3 |          2.5 |          4.5 |          9.7 |         23.3 |          9.3 |          7.3 |          5.9 |         51.4 |
| first paint ms      |         62.0 |         30.8 |         47.0 |         58.8 |         91.5 |         61.8 |         60.0 |         56.3 |        212.5 |

Script time in ms shows where gg loses:

| bench               |   gg | vanillajs | solid | inferno |
| ------------------- | ---: | --------: | ----: | ------: |
| run1k               |  9.6 |       1.7 |   2.9 |     2.7 |
| select1k            |  1.0 |       0.1 |   0.8 |     1.0 |
| swap1k              |  5.0 |       0.1 |   1.1 |     1.0 |
| create10k           | 79.7 |      15.7 |  24.1 |    26.7 |
| create1k-after1k_x2 |  9.8 |       1.7 |   3.1 |     3.3 |

- Row creation costs 3 to 4 times the script of solid, and run memory is twice that of vanillajs.
- select1k took 10.3 ms while rows rewrote every label, because a new text node relays out the whole table, and it takes 4.8 ms now that an unchanged label stays.
- swap1k spends 4 times the script of solid.
- remove-one-1k and select1k are with the fastest.

A trace of 10k row creation shows no single hot spot in gg:
- Native `createElement`, `setAttribute`, `append`, `addEventListener` and `createTextNode` take about 20 ms, where solid clones a template.
- The rest spreads over the async generator, the `Item` and the host drive of each row, plus 10 ms of GC.
- A row that binds its class and label with `derive` takes 4 times the script of the generator row to create, because each binding adds a reader and a drive.
