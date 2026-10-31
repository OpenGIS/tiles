import { expect, test } from '@playwright/test';

function isLocalRequest(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol === 'blob:' || url.protocol === 'data:') {
    return true;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
}

test('renders the offline basemap harness', async ({ page }, testInfo) => {
  const consoleErrors = [];
  const pageErrors = [];
  const failedResponses = [];
  const externalRequests = [];
  const contourTileResponses = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  page.on('response', (response) => {
    const { pathname } = new URL(response.url());

    if (/^\/contours\/\d+\/\d+\/\d+\.pbf$/.test(pathname)) {
      contourTileResponses.push({
        status: response.status(),
        length: Number(response.headers()['content-length'] ?? 0),
      });
    }

    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  page.on('request', (request) => {
    if (!isLocalRequest(request.url())) {
      externalRequests.push(request.url());
    }
  });

  await page.goto('/');

  await expect(page.locator('body')).toHaveAttribute('data-map-ready', 'true', {
    timeout: 30000,
  });
  expect(await page.locator('body').getAttribute('data-map-error')).toBeNull();

  await expect(page.locator('#sources')).toHaveAttribute('data-sources-ready', 'true');

  await expect(page.locator('[data-source="pois"]')).toBeVisible();
  await expect(page.locator('[data-source="routes"]')).toBeVisible();
  await expect(page.locator('[data-source="paths"]')).toBeVisible();
  await expect(page.locator('[data-source="contours"]')).toBeVisible();

  await expect(page.locator('[aria-label="Outdoor POIs: unavailable"]')).toBeVisible();
  await expect(page.locator('[aria-label="Outdoor routes: unavailable"]')).toBeVisible();
  await expect(page.locator('[aria-label="Outdoor paths: unavailable"]')).toBeVisible();
  await expect(page.locator('[aria-label="Terrain contours: available"]')).toBeVisible();

  await expect(page.locator('[data-source="pois"]')).toBeDisabled();
  await expect(page.locator('[data-source="routes"]')).toBeDisabled();
  await expect(page.locator('[data-source="paths"]')).toBeDisabled();
  await expect(page.locator('[data-source="contours"]')).toBeChecked();
  await expect(page.locator('[data-source="contours"]')).toBeEnabled();

  await expect(page.locator('body')).toHaveAttribute('data-contour-layer', 'true', {
    timeout: 30000,
  });

  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();

  const attribution = page.locator('.maplibregl-ctrl-attrib');
  await expect(attribution).toContainText('OpenFreeMap');
  await expect(attribution).toContainText('OpenStreetMap');
  await expect(attribution).toContainText('Mapterhorn');

  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('harness.png'), fullPage: true });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
  expect(externalRequests).toEqual([]);

  await expect
    .poll(
      () =>
        contourTileResponses.filter((response) => response.status === 200 && response.length > 0)
          .length,
      {
        message: 'expected at least one contour tile to load',
        timeout: 20000,
      },
    )
    .toBeGreaterThan(0);
});
