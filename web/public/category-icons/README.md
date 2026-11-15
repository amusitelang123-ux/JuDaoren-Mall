# 分类图标（Category Icons）

本目录存放用户端分类导航使用的 SVG 图标。

- 图标集：[IconPark TwoTone](https://github.com/bytedance/IconPark)（字节跳动开源）
- 许可证：Apache License 2.0，全文见同目录 `LICENSE`
- 获取方式：通过 [Iconify](https://iconify.design/) API 下载 `icon-park-twotone` 图标，统一画布为 96 × 96，并按分类主色替换 `currentColor`、写入本地，避免依赖外部 CDN。

| 文件 | IconPark 图标 | 用途 | 主色 |
| --- | --- | --- | --- |
| `digital.svg` | `iphone` | 数码电子 | `#2563EB` |
| `fashion.svg` | `t-shirt` | 服饰鞋包 | `#DB2777` |
| `home.svg` | `sofa` | 家居生活 | `#D97706` |
| `food.svg` | `vegetable-basket` | 食品生鲜 | `#16A34A` |
| `beauty.svg` | `lipstick-one` | 美妆个护 | `#E11D48` |
| `baby.svg` | `baby` | 母婴玩具 | `#EA580C` |
| `sports.svg` | `basketball-one` | 运动户外 | `#0891B2` |
| `books.svg` | `book-open` | 图书文娱 | `#7C3AED` |
| `all.svg` | `all-application` | 全部商品 / 全部分类 | `#475569` |

> 修改说明：仅调整了 SVG 的尺寸声明和主色，未改动图形结构。分类与图标的映射及底色定义在 `web/src/utils/categoryIcon.ts`。
