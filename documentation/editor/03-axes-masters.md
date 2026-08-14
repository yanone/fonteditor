# Axes and masters

Variable font work is a set of explicit design locations connected by interpolation. Counterpunch shows those relationships so you can move between masters and intermediate states and watch shape continuity.

An **axis** is a design dimension such as weight or width. A **master** is a stored design at a location on one or more axes. **Interpolation** is the generated shape between masters. The goal is shapes that stay coherent across the design space, not only at the extremes.

![Axis controls for the current design location](images/axes.png)

Define axes and masters in Font Info (**Axes** and **Masters** tabs). In the Editor, the axis sliders move the current design location. Edit a glyph at one master, then at another, and move the sliders to check the path between them. Compatible point structures matter. Smooth in-betweens are the target. A jump or kink on the slider usually means the masters do not match.

Stored layers and intermediate locations are in [Layer operations](05-layer-operations.md). Terms are in the [Glossary](../reference/glossary.md).
