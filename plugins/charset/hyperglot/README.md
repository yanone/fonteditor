# Hyperglot Character Set Plugin

Build the bundled wheel with:

```sh
python3 plugins/charset/hyperglot/build.py
```

The build pins Hyperglot `0.8.1` at commit
`b84944b259ef1b10fbef2ff34b99389a0a7f50a9`, resolves its YAML character-set
inheritance at build time, and writes the generated, reviewable
`counterpunch_hyperglot/data.json` source artifact before packaging that exact
file into the dependency-free wheel at `webapp/wheels/`. The generated data and
wheel are Apache-2.0 licensed through their upstream data source.
