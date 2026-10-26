<script lang="ts">
  import tokens from "../design/tokens.json";

  type Dimension = { value: number; unit: string };
  type Token = { $value: any };

  const entries = (group: Record<string, any>) =>
    Object.entries(group).filter(([key, value]: [string, any]) => !key.startsWith("$") && value?.$value) as [
      string,
      Token,
    ][];

  const colorTokens = entries(tokens.color) as [string, { $value: { hex: string } }][];
  const coreColors = colorTokens.filter(([name]) => !name.startsWith("flow-"));
  const flowColors = colorTokens.filter(([name]) => name.startsWith("flow-"));
  const typeTokens = entries(tokens.typography) as [
    string,
    { $value: { fontFamily: string; fontSize: Dimension; fontWeight: number } },
  ][];
  const spacingTokens = entries(tokens.spacing) as [string, { $value: Dimension }][];
  const radiusTokens = entries(tokens.rounded) as [string, { $value: Dimension }][];

  const css = (dimension: Dimension) => `${dimension.value}${dimension.unit}`;
  const palette = Object.fromEntries(colorTokens.map(([name, token]) => [name, token.$value.hex]));
  const space = (name: string) => css(tokens.spacing[name].$value);
  const surface = palette["surface"];
  const background = palette["background"];
  const foreground = palette["foreground"];
  const muted = palette["muted-foreground"];
  const border = palette["border"];
</script>

<div
  style="box-sizing:border-box; height:100vh; overflow:auto; padding:{space('section')};
    background:{background}; color:{foreground}; font-family:{tokens.typography.body.$value.fontFamily};
    font-size:{css(tokens.typography.body.$value.fontSize)};"
>
  <header style="max-width:960px;">
    <h1
      style="margin:0; font-size:{css(tokens.typography['page-title'].$value.fontSize)};
        font-weight:{tokens.typography['page-title'].$value.fontWeight};"
    >
      Design system
    </h1>
    <p style="margin:{space('tight')} 0 0; color:{muted}; font-size:{css(
      tokens.typography['body-small'].$value.fontSize,
    )}; max-width:72ch;">
      Specimen projection of <code style="font-family:{tokens.typography.mono.$value.fontFamily};">DESIGN.md</code>
      through <code style="font-family:{tokens.typography.mono.$value.fontFamily};">design/tokens.json</code>. Every
      value below is read from the generated DTCG file; no brand value is written here.
    </p>
  </header>

  <section style="margin-top:{space('section')};">
    <h2
      style="margin:0 0 {space('base')}; font-size:{css(tokens.typography['panel-title'].$value.fontSize)};
        font-weight:{tokens.typography['panel-title'].$value.fontWeight}; text-transform:uppercase;
        color:{muted};"
    >
      Colors
    </h2>
    <div
      style="display:grid; grid-template-columns:repeat(auto-fill, minmax(168px, 1fr)); gap:{space('base')};"
    >
      {#each coreColors as [name, token]}
        <figure style="margin:0; min-width:0;">
          <div
            style="height:{space('section-xl')}; border-radius:{css(tokens.rounded.md.$value)}; border:1px solid {border};
              background:{token.$value.hex};"
          ></div>
          <figcaption style="margin-top:{space('tight')}; font-size:{css(
            tokens.typography.label.$value.fontSize,
          )}; color:{foreground}; overflow-wrap:anywhere;">
            {name}
            <span
              style="display:block; color:{muted}; font-family:{tokens.typography.mono.$value.fontFamily};"
            >
              {token.$value.hex}
            </span>
          </figcaption>
        </figure>
      {/each}
    </div>

    <h3
      style="margin:{space('section')} 0 {space('base')}; font-size:{css(
        tokens.typography.label.$value.fontSize,
      )}; font-weight:{tokens.typography.label.$value.fontWeight};
        color:{muted}; text-transform:uppercase;"
    >
      Flow categories
    </h3>
    <div
      style="display:grid; grid-template-columns:repeat(auto-fill, minmax(168px, 1fr)); gap:{space('base')};"
    >
      {#each flowColors as [name, token]}
        <figure style="margin:0; min-width:0;">
          <div
            style="height:{space('section-xl')}; border-radius:{css(tokens.rounded.md.$value)}; border:1px solid {border};
              background:{token.$value.hex};"
          ></div>
          <figcaption style="margin-top:{space('tight')}; font-size:{css(
            tokens.typography.label.$value.fontSize,
          )}; color:{foreground}; overflow-wrap:anywhere;">
            {name}
            <span
              style="display:block; color:{muted}; font-family:{tokens.typography.mono.$value.fontFamily};"
            >
              {token.$value.hex}
            </span>
          </figcaption>
        </figure>
      {/each}
    </div>
  </section>

  <section style="margin-top:{space('section')};">
    <h2
      style="margin:0 0 {space('base')}; font-size:{css(tokens.typography['panel-title'].$value.fontSize)};
        font-weight:{tokens.typography['panel-title'].$value.fontWeight}; text-transform:uppercase;
        color:{muted};"
    >
      Typography
    </h2>
    <div style="display:grid; gap:{space('loose')};">
      {#each typeTokens as [name, token]}
        <div
          style="display:flex; align-items:baseline; justify-content:space-between; gap:{space(
            'base',
          )}; border-bottom:1px solid {border}; padding-bottom:{space('snug')};"
        >
          <span
            style="font-family:{token.$value.fontFamily}; font-size:{css(token.$value.fontSize)};
              font-weight:{token.$value.fontWeight}; min-width:0; overflow-wrap:anywhere;"
          >
            The quick brown fox / {name}
          </span>
          <span
            style="color:{muted}; font-family:{tokens.typography.mono.$value.fontFamily};
              font-size:{css(tokens.typography.mono.$value.fontSize)}; white-space:nowrap;"
          >
            {css(token.$value.fontSize)} / {token.$value.fontWeight}
          </span>
        </div>
      {/each}
    </div>
  </section>

  <section style="margin-top:{space('section')};">
    <h2
      style="margin:0 0 {space('base')}; font-size:{css(tokens.typography['panel-title'].$value.fontSize)};
        font-weight:{tokens.typography['panel-title'].$value.fontWeight}; text-transform:uppercase;
        color:{muted};"
    >
      Spacing
    </h2>
    <div style="display:grid; gap:{space('snug')}; max-width:560px;">
      {#each spacingTokens as [name, token]}
        <div style="display:flex; align-items:center; gap:{space('base')};">
          <span
            style="width:72px; color:{muted}; font-family:{tokens.typography.mono.$value.fontFamily};
              font-size:{css(tokens.typography.mono.$value.fontSize)};"
          >
            {name}
          </span>
          <span
            style="height:{space('base')}; width:{css(token.$value)}; background:{palette.primary};
              border-radius:{css(tokens.rounded.sm.$value)};"
          ></span>
          <span
            style="color:{muted}; font-family:{tokens.typography.mono.$value.fontFamily};
              font-size:{css(tokens.typography.mono.$value.fontSize)};"
          >
            {css(token.$value)}
          </span>
        </div>
      {/each}
    </div>
  </section>

  <section style="margin-top:{space('section')}; margin-bottom:{space('section')};">
    <h2
      style="margin:0 0 {space('base')}; font-size:{css(tokens.typography['panel-title'].$value.fontSize)};
        font-weight:{tokens.typography['panel-title'].$value.fontWeight}; text-transform:uppercase;
        color:{muted};"
    >
      Radii
    </h2>
    <div style="display:flex; flex-wrap:wrap; gap:{space('loose')};">
      {#each radiusTokens as [name, token]}
        <figure style="margin:0;">
          <div
            style="width:{space('section-xl')}; height:{space('section-xl')};
              background:{surface}; border:1px solid {border};
              border-radius:{css(token.$value)};"
          ></div>
          <figcaption
            style="margin-top:{space('tight')}; color:{muted};
              font-family:{tokens.typography.mono.$value.fontFamily};
              font-size:{css(tokens.typography.mono.$value.fontSize)};"
          >
            {name} · {css(token.$value)}
          </figcaption>
        </figure>
      {/each}
    </div>
  </section>
</div>
