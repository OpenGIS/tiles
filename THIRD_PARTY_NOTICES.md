# Third-party notices

There is no root `LICENSE` or `NOTICE` file; the project code licence is not yet decided. This file
records the licences of third-party software used by the tile server and its tooling.

| Component          | Version                    | Licence           |
| ------------------ | -------------------------- | ----------------- |
| `maplibre-contour` | 0.1.1                      | BSD-3-Clause      |
| `sharp`            | ^0.35.5                    | Apache-2.0        |
| libvips            | 8.18.7, bundled by `sharp` | LGPL-2.1-or-later |

`maplibre-contour` includes code from d3-contour (ISC) and vt-pbf (MIT). Those notices are reproduced
in its licence text below.

## maplibre-contour

<https://github.com/onthegomap/maplibre-contour>

BSD 3-Clause License

Copyright (c) 2023, Michael Barry and maplibre-contour contributors

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### d3-contour

<https://github.com/d3/d3-contour>

Copyright 2012-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

### vt-pbf

<https://github.com/mapbox/vt-pbf>

The MIT License (MIT)

Copyright (c) 2015 Anand Thakker

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## sharp

<https://sharp.pixelplumbing.com>

Copyright 2013 Lovell Fuller and others.

`sharp` is licensed under the Apache License, Version 2.0. The full text is available at
<https://www.apache.org/licenses/LICENSE-2.0> and in the upstream repository:
<https://github.com/lovell/sharp/blob/main/LICENSE>.

## libvips

<https://www.libvips.org>

`sharp` installs a prebuilt libvips binary through an `@img/sharp-libvips-*` package. libvips is
licensed under the GNU Lesser General Public License, version 2.1 or later. The packaged binaries
declare `LGPL-3.0-or-later` in their package metadata, which is compatible with the "or later" option
of LGPL-2.1.

- LGPL-2.1 text: <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>
- libvips licence: <https://github.com/libvips/libvips/blob/master/COPYING>
- `sharp` libvips packaging: <https://github.com/lovell/sharp-libvips>

## Data

- OpenStreetMap-derived data is available under the Open Database Licence (ODbL). See
  <https://www.openstreetmap.org/copyright>.
- Contour tiles use Mapterhorn DEM data. Attribution is required; see
  <https://mapterhorn.com/attribution> for upstream sources and terms.
- The vendored development basemap has its own notices and licence texts in
  [`dev/basemap/NOTICE`](dev/basemap/NOTICE).
