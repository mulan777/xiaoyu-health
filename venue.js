const path = require('path');
const fs = require('fs');
const { normalizeText, toNullableInt, asyncHandler, gradeLabel, requireRole, chinaNowText } = require('../lib/helpers');
const { getPool, dbQuery } = require('../lib/db');
const { audit } = require('../lib/logger');

function capField(gradeLevel) {
  if (gradeLevel === 'small') return 'cap_small';
  if (gradeLevel === 'middle') return 'cap_middle';
  return 'cap_large';
}

function visiblePoolsForGrade(gradeLevel) {
  return gradeLevel === 'small' ? ['small'] : ['middle', 'large'];
}

function roundSelectSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `
    ${prefix}id,
    ${prefix}round_date,
    ${prefix}open_time,
    ${prefix}close_time,
    ${prefix}status,
    DATE_FORMAT(${prefix}round_date, '%Y-%m-%d') AS round_date_text,
    DATE_FORMAT(${prefix}open_time, '%Y-%m-%d %H:%i:%s') AS open_time_text,
    CASE WHEN ${prefix}close_time IS NOT NULL THEN DATE_FORMAT(${prefix}close_time, '%Y-%m-%d %H:%i:%s') ELSE NULL END AS close_time_text
  `;
}

function deleteUploadedFile(urlPath) {
  if (!urlPath) return;
  try {
    // /static/uploads/xxx.png -> public/uploads/xxx.png
    const relative = urlPath.replace(/^\/static\//, '');
    const fullPath = path.join(__dirname, '..', 'public', relative);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch (e) { /* ignore cleanup errors */ }
}

function saveUploadedFile(file, prefix) {
  if (!file) return null;
  const ext = path.extname(file.originalname || '') || '.png';
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const destination = path.join(__dirname, '..', 'public', 'uploads', filename);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, file.buffer);
  return `/static/uploads/${filename}`;
}

function firstFile(files, key) {
  return files && files[key] && files[key][0] ? files[key][0] : null;
}

function attachLayoutDefaults(venues) {
  const defaultWidth = 100;
  const defaultHeight = 65;
  const gapX = 8;
  const gapY = 8;
  const startX = 16;
  const startY = 16;
  const columns = 5;
  const boardPaddingX = 40;
  const boardPaddingY = 40;
  const hasCustomLayout = venues.some((venue) =>
    venue.map_x != null || venue.map_y != null || venue.map_width != null || venue.map_height != null
  );

  let minLeft = Number.POSITIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;
  let maxRight = 0;
  let maxBottom = 0;

  venues.forEach((venue, index) => {
    const fallbackX = startX + (index % columns) * (defaultWidth + gapX);
    const fallbackY = startY + Math.floor(index / columns) * (defaultHeight + gapY);
    const width = Number(venue.map_width || venue.image_width || defaultWidth);
    const height = Number(venue.map_height || Math.max(Number(venue.image_height || 180) + 96, defaultHeight));
    const x = venue.map_x == null ? fallbackX : Number(venue.map_x);
    const y = venue.map_y == null ? fallbackY : Number(venue.map_y);

    venue.map_x = x;
    venue.map_y = y;
    venue.map_width = width;
    venue.map_height = height;

    minLeft = Math.min(minLeft, x);
    minTop = Math.min(minTop, y);
    maxRight = Math.max(maxRight, x + width);
    maxBottom = Math.max(maxBottom, y + height);
  });

  const contentWidth = venues.length ? maxRight - minLeft : defaultWidth;
  const contentHeight = venues.length ? maxBottom - minTop : defaultHeight;
  const minBoardWidth = hasCustomLayout ? 960 : 700;
  const minBoardHeight = hasCustomLayout ? 540 : 420;
  const boardWidth = Math.max(minBoardWidth, Math.ceil(contentWidth + boardPaddingX * 2));
  const boardHeight = Math.max(minBoardHeight, Math.ceil(contentHeight + boardPaddingY * 2));

  if (venues.length) {
    const offsetX = Math.round((boardWidth - contentWidth) / 2 - minLeft);
    const offsetY = Math.round((boardHeight - contentHeight) / 2 - minTop);

    venues.forEach((venue) => {
      venue.map_x += offsetX;
      venue.map_y += offsetY;
    });
  }

  return {
    venues,
    boardWidth,
    boardHeight
  };
}

function groupRowsByVenue(rows) {
  return rows.reduce((accumulator, row) => {
    const venueId = Number(row.venue_id);
    if (!accumulator[venueId]) accumulator[venueId] = [];
    accumulator[venueId].push(row);
    return accumulator;
  }, {});
}

async function loadVenueElements(venueIds, onlyEnabled = false) {
  if (!venueIds.length) return {};
  const placeholders = venueIds.map(() => '?').join(', ');
  const whereEnabled = onlyEnabled ? " AND enabled = 1" : '';
  const rows = await dbQuery(
    `SELECT * FROM venue_elements
      WHERE venue_id IN (${placeholders})${whereEnabled}
      ORDER BY venue_id ASC, sort_order ASC, id ASC`,
    venueIds
  );
  return groupRowsByVenue(rows);
}

async function loadVenueBackgrounds(onlyEnabled = false) {
  const whereEnabled = onlyEnabled ? 'WHERE enabled = 1' : '';
  return dbQuery(
    `SELECT * FROM venue_backgrounds
      ${whereEnabled}
      ORDER BY sort_order ASC, id ASC`
  );
}

function normalizeBackgroundLayers(backgrounds) {
  return (backgrounds || []).map((background, index) => {
    const width = Math.max(80, Number(background.map_width || 320));
    const height = Math.max(80, Number(background.map_height || 180));
    const x = Math.max(0, Number(background.map_x || 0));
    const y = Math.max(0, Number(background.map_y || 0));
    return {
      ...background,
      map_x: x,
      map_y: y,
      map_width: width,
      map_height: height,
      sort_order: Number(background.sort_order || index + 1),
      enabled: Number(background.enabled) ? 1 : 0,
      is_fixed: Number(background.is_fixed) ? 1 : 0
    };
  });
}

function applyLayoutBoardOffset(layout, backgrounds = []) {
  const layers = normalizeBackgroundLayers(backgrounds);
  let minLeft = Number.POSITIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;
  let maxRight = 0;
  let maxBottom = 0;
  let hasAny = false;

  const registerBounds = (x, y, width, height) => {
    minLeft = Math.min(minLeft, x);
    minTop = Math.min(minTop, y);
    maxRight = Math.max(maxRight, x + width);
    maxBottom = Math.max(maxBottom, y + height);
    hasAny = true;
  };

  (layout.venues || []).forEach((venue) => {
    registerBounds(Number(venue.map_x || 0), Number(venue.map_y || 0), Number(venue.map_width || 0), Number(venue.map_height || 0));
  });
  layers.forEach((background) => {
    registerBounds(background.map_x, background.map_y, background.map_width, background.map_height);
  });

  if (!hasAny) {
    return {
      venues: layout.venues || [],
      backgrounds: layers,
      boardWidth: layout.boardWidth,
      boardHeight: layout.boardHeight
    };
  }

  const boardPaddingX = 40;
  const boardPaddingY = 40;
  const contentWidth = maxRight - minLeft;
  const contentHeight = maxBottom - minTop;
  const boardWidth = Math.max(layout.boardWidth || 700, Math.ceil(contentWidth + boardPaddingX * 2));
  const boardHeight = Math.max(layout.boardHeight || 420, Math.ceil(contentHeight + boardPaddingY * 2));
  const offsetX = Math.round((boardWidth - contentWidth) / 2 - minLeft);
  const offsetY = Math.round((boardHeight - contentHeight) / 2 - minTop);

  const shiftedVenues = (layout.venues || []).map((venue) => ({
    ...venue,
    map_x: Number(venue.map_x || 0) + offsetX,
    map_y: Number(venue.map_y || 0) + offsetY
  }));
  const shiftedBackgrounds = layers.map((background) => ({
    ...background,
    map_x: background.map_x + offsetX,
    map_y: background.map_y + offsetY
  }));

  return {
    venues: shiftedVenues,
    backgrounds: shiftedBackgrounds,
    boardWidth,
    boardHeight
  };
}

module.exports = function mountVenueRoutes(app, upload) {
  const adminOnly = requireRole('admin');
  const userOnly = requireRole('user');

  app.get('/admin/venues', adminOnly, asyncHandler(async (req, res) => {
    const venues = await dbQuery('SELECT * FROM venues ORDER BY sort_order ASC, id ASC');
    const rounds = await dbQuery(`SELECT ${roundSelectSql()} FROM venue_round ORDER BY round_date DESC LIMIT 20`);
    const layout = attachLayoutDefaults(venues);
    const backgrounds = await loadVenueBackgrounds(false);
    const layoutWithBackgrounds = applyLayoutBoardOffset(layout, backgrounds);
    const elementsByVenue = await loadVenueElements(layoutWithBackgrounds.venues.map((venue) => venue.id));

    layoutWithBackgrounds.venues.forEach((venue) => {
      venue.elements = elementsByVenue[venue.id] || [];
    });

    res.render('admin-venues', {
      venues: layoutWithBackgrounds.venues,
      backgrounds: layoutWithBackgrounds.backgrounds,
      rounds,
      layoutBoardWidth: layoutWithBackgrounds.boardWidth,
      layoutBoardHeight: layoutWithBackgrounds.boardHeight,
      message: normalizeText(req.query.message),
      title: '场地预约管理'
    });
  }));

  app.post('/admin/venues/add', adminOnly, upload.fields([{name:'image',maxCount:1},{name:'playImagesSmall',maxCount:10},{name:'playImagesMl',maxCount:10}]), asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name);
    if (!name) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('请输入场地名称'));
    }

    const capSmall = Math.max(0, Number(req.body.capSmall) || 1);
    const capMiddle = Math.max(0, Number(req.body.capMiddle) || 2);
    const capLarge = Math.max(0, Number(req.body.capLarge) || 2);
    const playDescSmall = normalizeText(req.body.playDescSmall);
    const playDescMl = normalizeText(req.body.playDescMl);
    const imgWidth = toNullableInt(req.body.imageWidth) || 280;
    const imgHeight = toNullableInt(req.body.imageHeight) || 180;
    const sortOrder = Number(req.body.sortOrder) || 1;
    const equipment = normalizeText(req.body.equipment);
    const imageFile = req.files && req.files.image ? req.files.image[0] : null;
    const imagePath = saveUploadedFile(imageFile, 'venue');
    const playImgSmall = (req.files && req.files.playImagesSmall || []).map(f => saveUploadedFile(f, 'venue')).filter(Boolean);
    const playImgMl = (req.files && req.files.playImagesMl || []).map(f => saveUploadedFile(f, 'venue')).filter(Boolean);

    await dbQuery(
      `INSERT INTO venues (
         name, image_path, image_width, image_height, play_desc_small, play_images_small, play_desc_ml, play_images_ml,
         cap_small, cap_middle, cap_large, sort_order, equipment, enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [name, imagePath, imgWidth, imgHeight, playDescSmall, JSON.stringify(playImgSmall), playDescMl, JSON.stringify(playImgMl), capSmall, capMiddle, capLarge, sortOrder, equipment]
    );

    audit('venue_added', { actor: req.session.user, venueName: name, ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent(`场地「${name}」添加成功`));
  }));

  app.post('/admin/venues/:id/edit', adminOnly, upload.fields([{name:'image',maxCount:1},{name:'playImagesSmall',maxCount:10},{name:'playImagesMl',maxCount:10}]), asyncHandler(async (req, res) => {
    const venueId = Number(req.params.id);
    const name = normalizeText(req.body.name);
    const capSmall = Math.max(0, Number(req.body.capSmall) || 0);
    const capMiddle = Math.max(0, Number(req.body.capMiddle) || 0);
    const capLarge = Math.max(0, Number(req.body.capLarge) || 0);
    const playDescSmall = normalizeText(req.body.playDescSmall);
    const playDescMl = normalizeText(req.body.playDescMl);
    const imgWidth = toNullableInt(req.body.imageWidth) || 280;
    const imgHeight = toNullableInt(req.body.imageHeight) || 180;
    const sortOrder = Number(req.body.sortOrder) || 1;
    const equipment = normalizeText(req.body.equipment);
    const imageFile = req.files && req.files.image ? req.files.image[0] : null;
    const imagePath = saveUploadedFile(imageFile, 'venue');

    // 处理玩法图片
    const existingRows = await dbQuery('SELECT play_images_small, play_images_ml FROM venues WHERE id = ?', [venueId]);
    const existRow = existingRows[0] || {};
    let existSmall = []; let existMl = [];
    try { existSmall = JSON.parse(existRow.play_images_small || '[]'); } catch(e) {}
    try { existMl = JSON.parse(existRow.play_images_ml || '[]'); } catch(e) {}
    const newSmall = (req.files && req.files.playImagesSmall || []).map(f => saveUploadedFile(f, 'venue')).filter(Boolean);
    const newMl = (req.files && req.files.playImagesMl || []).map(f => saveUploadedFile(f, 'venue')).filter(Boolean);
    const removeSmall = [].concat(req.body.removePlayImagesSmall || []).filter(Boolean);
    const removeMl = [].concat(req.body.removePlayImagesMl || []).filter(Boolean);
    // Delete removed play images from disk
    removeSmall.forEach(p => deleteUploadedFile(p));
    removeMl.forEach(p => deleteUploadedFile(p));
    const finalSmall = existSmall.filter(p => !removeSmall.includes(p)).concat(newSmall);
    const finalMl = existMl.filter(p => !removeMl.includes(p)).concat(newMl);

    const params = [name, imgWidth, imgHeight, playDescSmall, JSON.stringify(finalSmall), playDescMl, JSON.stringify(finalMl), capSmall, capMiddle, capLarge, sortOrder, equipment];
    let imageSql = '';
    if (imagePath) {
      // clean up old venue image
      const oldImgRows = await dbQuery('SELECT image_path FROM venues WHERE id = ?', [venueId]);
      if (oldImgRows[0] && oldImgRows[0].image_path) deleteUploadedFile(oldImgRows[0].image_path);
      imageSql = ', image_path = ?';
      params.push(imagePath);
    }
    params.push(venueId);

    await dbQuery(
      `UPDATE venues
          SET name = ?, image_width = ?, image_height = ?, play_desc_small = ?, play_images_small = ?, play_desc_ml = ?, play_images_ml = ?,
              cap_small = ?, cap_middle = ?, cap_large = ?, sort_order = ?, equipment = ?${imageSql}
        WHERE id = ?`,
      params
    );

    audit('venue_updated', { actor: req.session.user, venueId, venueName: name, ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent('场地已更新'));
  }));

  app.post('/admin/venues/layout', adminOnly, asyncHandler(async (req, res) => {
    const raw = normalizeText(req.body.layoutJson);
    let items = [];

    try {
      items = JSON.parse(raw || '[]');
    } catch (error) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('布局数据格式不正确'));
    }

    for (const item of items) {
      const entityType = normalizeText(item.type) === 'background' ? 'background' : 'venue';
      const entityId = Number(item.id);
      if (!Number.isInteger(entityId) || entityId <= 0) continue;

      const x = Math.max(0, Math.round(Number(item.x) || 0));
      const y = Math.max(0, Math.round(Number(item.y) || 0));
      const width = Math.max(60, Math.round(Number(item.width) || 100));
      const height = Math.max(40, Math.round(Number(item.height) || 65));

      if (entityType === 'background') {
        await dbQuery(
          `UPDATE venue_backgrounds
              SET map_x = ?, map_y = ?, map_width = ?, map_height = ?, sort_order = ?, is_fixed = ?, enabled = ?
            WHERE id = ?`,
          [
            x,
            y,
            Math.max(80, width),
            Math.max(80, height),
            Math.max(1, Math.round(Number(item.sortOrder) || 1)),
            normalizeText(item.isFixed) === '1' || Number(item.isFixed) ? 1 : 0,
            normalizeText(item.enabled) === '0' || Number(item.enabled) === 0 ? 0 : 1,
            entityId
          ]
        );
      } else {
        await dbQuery(
          `UPDATE venues
              SET map_x = ?, map_y = ?, map_width = ?, map_height = ?
            WHERE id = ?`,
          [x, y, width, height, entityId]
        );
      }
    }

    audit('venue_layout_saved', { actor: req.session.user, count: items.length, ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent('场地布局已保存'));
  }));

  app.post('/admin/venues/backgrounds/add', adminOnly, upload.fields([{ name: 'image', maxCount: 1 }]), asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name) || '背景层';
    await dbQuery(
      `INSERT INTO venue_backgrounds (
         name, image_path, map_x, map_y, map_width, map_height, sort_order, is_fixed, enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        saveUploadedFile(firstFile(req.files, 'image'), 'venue_bg'),
        Math.max(0, Number(req.body.mapX) || 0),
        Math.max(0, Number(req.body.mapY) || 0),
        Math.max(80, Number(req.body.mapWidth) || 600),
        Math.max(80, Number(req.body.mapHeight) || 320),
        Math.max(1, Number(req.body.sortOrder) || 1),
        normalizeText(req.body.isFixed) === '1' ? 1 : 0,
        normalizeText(req.body.enabled) === '0' ? 0 : 1
      ]
    );

    res.redirect('/admin/venues?message=' + encodeURIComponent('背景层已添加'));
  }));

  app.post('/admin/venues/backgrounds/:id/edit', adminOnly, upload.fields([{ name: 'image', maxCount: 1 }]), asyncHandler(async (req, res) => {
    const backgroundId = Number(req.params.id);
    const imagePath = saveUploadedFile(firstFile(req.files, 'image'), 'venue_bg');
    const updates = [
      normalizeText(req.body.name) || '背景层',
      Math.max(0, Number(req.body.mapX) || 0),
      Math.max(0, Number(req.body.mapY) || 0),
      Math.max(80, Number(req.body.mapWidth) || 600),
      Math.max(80, Number(req.body.mapHeight) || 320),
      Math.max(1, Number(req.body.sortOrder) || 1),
      normalizeText(req.body.isFixed) === '1' ? 1 : 0,
      normalizeText(req.body.enabled) === '0' ? 0 : 1
    ];

    let sql = `UPDATE venue_backgrounds
                  SET name = ?, map_x = ?, map_y = ?, map_width = ?, map_height = ?, sort_order = ?, is_fixed = ?, enabled = ?`;
    if (imagePath) {
      const oldRows = await dbQuery('SELECT image_path FROM venue_backgrounds WHERE id = ?', [backgroundId]);
      if (oldRows[0] && oldRows[0].image_path) deleteUploadedFile(oldRows[0].image_path);
      sql += ', image_path = ?';
      updates.push(imagePath);
    }
    sql += ' WHERE id = ?';
    updates.push(backgroundId);

    await dbQuery(sql, updates);
    res.redirect('/admin/venues?message=' + encodeURIComponent('背景层已更新'));
  }));

  app.post('/admin/venues/backgrounds/:id/delete', adminOnly, asyncHandler(async (req, res) => {
    const backgroundId = Number(req.params.id);
    const rows = await dbQuery('SELECT image_path FROM venue_backgrounds WHERE id = ?', [backgroundId]);
    if (rows[0] && rows[0].image_path) deleteUploadedFile(rows[0].image_path);
    await dbQuery('DELETE FROM venue_backgrounds WHERE id = ?', [backgroundId]);
    res.redirect('/admin/venues?message=' + encodeURIComponent('背景层已删除'));
  }));

  app.post('/admin/venues/:id/delete', adminOnly, asyncHandler(async (req, res) => {
    await dbQuery('DELETE FROM venues WHERE id = ?', [Number(req.params.id)]);
    audit('venue_deleted', { actor: req.session.user, venueId: Number(req.params.id), ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent('场地已删除'));
  }));

  app.post('/admin/venues/:id/toggle', adminOnly, asyncHandler(async (req, res) => {
    const rows = await dbQuery('SELECT enabled FROM venues WHERE id = ? LIMIT 1', [Number(req.params.id)]);
    if (rows.length) {
      await dbQuery('UPDATE venues SET enabled = ? WHERE id = ?', [rows[0].enabled ? 0 : 1, Number(req.params.id)]);
    }
    audit('venue_toggled', { actor: req.session.user, venueId: Number(req.params.id), ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent('状态已更新'));
  }));

  app.post(
    '/admin/venues/:id/elements/add',
    adminOnly,
    upload.fields([
      { name: 'icon', maxCount: 1 },
      { name: 'detailImageSmall', maxCount: 1 },
      { name: 'detailImageMl', maxCount: 1 }
    ]),
    asyncHandler(async (req, res) => {
      const venueId = Number(req.params.id);
      const elementName = normalizeText(req.body.elementName);
      if (!elementName) {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写游戏标记名称'));
      }

      await dbQuery(
        `INSERT INTO venue_elements (
           venue_id, element_name, icon_path, detail_image_small, detail_image_ml,
           detail_desc_small, detail_desc_ml, pos_x, pos_y, box_width, box_height, enabled, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          venueId,
          elementName,
          saveUploadedFile(firstFile(req.files, 'icon'), 'venue_element_icon'),
          saveUploadedFile(firstFile(req.files, 'detailImageSmall'), 'venue_element_small'),
          saveUploadedFile(firstFile(req.files, 'detailImageMl'), 'venue_element_ml'),
          normalizeText(req.body.detailDescSmall),
          normalizeText(req.body.detailDescMl),
          Math.max(0, Number(req.body.posX) || 20),
          Math.max(0, Number(req.body.posY) || 20),
          Math.max(24, Number(req.body.boxWidth) || 44),
          Math.max(24, Number(req.body.boxHeight) || 44),
          normalizeText(req.body.enabled) === '0' ? 0 : 1,
          Number(req.body.sortOrder) || 1
        ]
      );

      res.redirect('/admin/venues?message=' + encodeURIComponent(`已添加标记：${elementName}`));
    })
  );

  app.post(
    '/admin/venues/elements/:id/edit',
    adminOnly,
    upload.fields([
      { name: 'icon', maxCount: 1 },
      { name: 'detailImageSmall', maxCount: 1 },
      { name: 'detailImageMl', maxCount: 1 }
    ]),
    asyncHandler(async (req, res) => {
      const elementId = Number(req.params.id);
      const elementName = normalizeText(req.body.elementName);
      if (!elementName) {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写游戏标记名称'));
      }

      const updates = [
        elementName,
        normalizeText(req.body.detailDescSmall),
        normalizeText(req.body.detailDescMl),
        Math.max(0, Number(req.body.posX) || 20),
        Math.max(0, Number(req.body.posY) || 20),
        Math.max(24, Number(req.body.boxWidth) || 44),
        Math.max(24, Number(req.body.boxHeight) || 44),
        normalizeText(req.body.enabled) === '0' ? 0 : 1,
        Number(req.body.sortOrder) || 1
      ];

      let sql = `
        UPDATE venue_elements
           SET element_name = ?, detail_desc_small = ?, detail_desc_ml = ?, pos_x = ?, pos_y = ?,
               box_width = ?, box_height = ?, enabled = ?, sort_order = ?
      `;

      const iconPath = saveUploadedFile(firstFile(req.files, 'icon'), 'venue_element_icon');
      const detailImageSmall = saveUploadedFile(firstFile(req.files, 'detailImageSmall'), 'venue_element_small');
      const detailImageMl = saveUploadedFile(firstFile(req.files, 'detailImageMl'), 'venue_element_ml');

      if (iconPath) {
        sql += ', icon_path = ?';
        updates.push(iconPath);
      }
      if (detailImageSmall) {
        sql += ', detail_image_small = ?';
        updates.push(detailImageSmall);
      }
      if (detailImageMl) {
        sql += ', detail_image_ml = ?';
        updates.push(detailImageMl);
      }

      sql += ' WHERE id = ?';
      updates.push(elementId);

      await dbQuery(sql, updates);
      res.redirect('/admin/venues?message=' + encodeURIComponent('标记已更新'));
    })
  );

  app.post('/admin/venues/elements/:id/delete', adminOnly, asyncHandler(async (req, res) => {
    await dbQuery('DELETE FROM venue_elements WHERE id = ?', [Number(req.params.id)]);
    res.redirect('/admin/venues?message=' + encodeURIComponent('标记已删除'));
  }));

  app.post('/admin/venues/round/add', adminOnly, asyncHandler(async (req, res) => {
    const roundDate = normalizeText(req.body.roundDate);
    const openTime = normalizeText(req.body.openTime);
    const closeTime = normalizeText(req.body.closeTime) || null;

    if (!roundDate || !openTime) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写活动日期和开放时间'));
    }

    try {
      await dbQuery(
        `INSERT INTO venue_round (round_date, open_time, close_time, status)
         VALUES (?, ?, ?, 'pending')`,
        [roundDate, openTime.replace('T', ' '), closeTime ? closeTime.replace('T', ' ') : null]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('该日期已存在预约轮次'));
      }
      throw error;
    }

    res.redirect('/admin/venues?message=' + encodeURIComponent(`${roundDate} 预约轮次已创建`));
  }));

  app.post('/admin/venues/round/:id/status', adminOnly, asyncHandler(async (req, res) => {
    const status = normalizeText(req.body.status);
    if (!['pending', 'open', 'closed'].includes(status)) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('无效状态'));
    }

    await dbQuery('UPDATE venue_round SET status = ? WHERE id = ?', [status, Number(req.params.id)]);
    res.redirect('/admin/venues?message=' + encodeURIComponent('轮次状态已更新'));
  }));

  app.post('/admin/venues/round/:id/delete', adminOnly, asyncHandler(async (req, res) => {
    await dbQuery('DELETE FROM venue_round WHERE id = ?', [Number(req.params.id)]);
    res.redirect('/admin/venues?message=' + encodeURIComponent('轮次已删除'));
  }));

  app.get('/admin/venues/bookings', adminOnly, asyncHandler(async (req, res) => {
    const roundId = toNullableInt(req.query.roundId);
    const rounds = await dbQuery(`SELECT ${roundSelectSql()} FROM venue_round ORDER BY round_date DESC LIMIT 30`);
    let bookings = [];
    let selectedRound = null;

    if (roundId) {
      selectedRound = (await dbQuery(`SELECT ${roundSelectSql()} FROM venue_round WHERE id = ? LIMIT 1`, [roundId]))[0] || null;
      bookings = await dbQuery(`
        SELECT vb.*, v.name AS venue_name, c.name AS class_name, c.grade_level, u.name AS teacher_name
          FROM venue_bookings vb
          JOIN venues v ON v.id = vb.venue_id
          JOIN classes c ON c.id = vb.class_id
          JOIN users u ON u.id = vb.user_id
         WHERE vb.round_id = ?
         ORDER BY v.sort_order ASC, vb.grade_pool ASC, c.name ASC
      `, [roundId]);
    }

    res.render('admin-venue-bookings', {
      rounds,
      bookings,
      selectedRound,
      roundId,
      title: '预约记录',
      message: normalizeText(req.query.message),
      gradeLabel
    });
  }));

  app.post('/admin/venues/bookings/:id/cancel', adminOnly, asyncHandler(async (req, res) => {
    const roundId = normalizeText(req.query.roundId) || '';
    await dbQuery(`UPDATE venue_bookings SET status = 'cancelled' WHERE id = ?`, [Number(req.params.id)]);
    res.redirect(`/admin/venues/bookings?roundId=${roundId}&message=` + encodeURIComponent('已取消'));
  }));

  app.get('/user/venues', userOnly, asyncHandler(async (req, res) => {
    const user = req.session.user;
    const baseView = {
      venues: [],
      backgrounds: [],
      activeRound: null,
      bookingMap: {},
      myGrade: null,
      myGradeLabel: '',
      classId: null,
      attentionChildren: [],
      layoutBoardWidth: 860,
      layoutBoardHeight: 420,
      message: normalizeText(req.query.message),
      now: Date.now()
    };

    if (!user.classId) {
      return res.render('user-venues', {
        ...baseView,
        message: '您的账号未绑定班级，请联系管理员。'
      });
    }

    const classRows = await dbQuery('SELECT grade_level FROM classes WHERE id = ? LIMIT 1', [user.classId]);
    const myGrade = classRows.length ? classRows[0].grade_level : 'small';
    const myGradeLabel = gradeLabel(myGrade);

    const roundRows = await dbQuery(`
      SELECT ${roundSelectSql()}
        FROM venue_round
       WHERE status IN ('pending', 'open')
       ORDER BY round_date ASC
       LIMIT 1
    `);
    let activeRound = roundRows[0] || null;

    let venues = [];
    let backgrounds = [];
    let bookingMap = {};
    let attentionChildren = [];
    let layoutBoardWidth = 860;
    let layoutBoardHeight = 420;

    if (activeRound) {
      const nowText = chinaNowText();
      if (activeRound.status === 'pending' && nowText >= activeRound.open_time_text) {
        await dbQuery('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['open', activeRound.id, 'pending']);
        activeRound.status = 'open';
      }
      if (activeRound.close_time_text && nowText >= activeRound.close_time_text && activeRound.status === 'open') {
        await dbQuery('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['closed', activeRound.id, 'open']);
        activeRound = null;
      }
    }

    if (activeRound) {
      venues = await dbQuery('SELECT * FROM venues WHERE enabled = 1 ORDER BY sort_order ASC, id ASC');
      backgrounds = await loadVenueBackgrounds(true);
      const layout = attachLayoutDefaults(venues);
      const layoutMerged = applyLayoutBoardOffset(layout, backgrounds);
      venues = layoutMerged.venues;
      backgrounds = layoutMerged.backgrounds;
      layoutBoardWidth = layoutMerged.boardWidth;
      layoutBoardHeight = layoutMerged.boardHeight;

      const venueIds = venues.map((venue) => venue.id);
      const elementsByVenue = await loadVenueElements(venueIds, true);
      const allBookingRows = venueIds.length
        ? await dbQuery(`
            SELECT vb.id, vb.venue_id, vb.class_id, vb.grade_pool, c.name AS class_name, c.grade_level
              FROM venue_bookings vb
              JOIN classes c ON c.id = vb.class_id
             WHERE vb.round_id = ?
               AND vb.status = 'confirmed'
               AND vb.venue_id IN (${venueIds.map(() => '?').join(', ')})
             ORDER BY vb.venue_id ASC, vb.grade_pool ASC, c.name ASC
          `, [activeRound.id, ...venueIds])
        : [];

      const bookingRowsByVenue = groupRowsByVenue(allBookingRows);
      const visiblePools = visiblePoolsForGrade(myGrade);

      venues.forEach((venue) => {
        const rows = bookingRowsByVenue[venue.id] || [];
        const smallRows = rows.filter((row) => row.grade_pool === 'small');
        const middleRows = rows.filter((row) => row.grade_pool === 'middle');
        const largeRows = rows.filter((row) => row.grade_pool === 'large');
        const visibleRows = rows.filter((row) => visiblePools.includes(row.grade_pool));

        venue.elements = elementsByVenue[venue.id] || [];
        venue._bookedSmall = smallRows.length;
        venue._bookedMiddle = middleRows.length;
        venue._bookedLarge = largeRows.length;
        venue._visibleBookings = visibleRows;
        venue._booked = visibleRows.length;
        venue._visibleCapacity = myGrade === 'small' ? venue.cap_small : venue.cap_middle + venue.cap_large;
        venue._myPoolBooked = myGrade === 'small'
          ? smallRows.length
          : myGrade === 'middle'
            ? middleRows.length
            : largeRows.length;
        venue._myPoolCapacity = venue[capField(myGrade)];
        venue._remainingVisible = Math.max(0, venue._visibleCapacity - venue._booked);
        venue._remainingMine = Math.max(0, venue._myPoolCapacity - venue._myPoolBooked);
        venue._full = venue._myPoolBooked >= venue._myPoolCapacity;
      });

      const myBookings = await dbQuery(
        `SELECT id, venue_id
           FROM venue_bookings
          WHERE round_id = ?
            AND class_id = ?
            AND status = 'confirmed'`,
        [activeRound.id, user.classId]
      );

      bookingMap = myBookings.reduce((accumulator, booking) => {
        accumulator[booking.venue_id] = booking;
        return accumulator;
      }, {});

      const bookedVenueIds = myBookings.map((booking) => Number(booking.venue_id)).filter(Boolean);
      if (bookedVenueIds.length) {
        attentionChildren = await dbQuery(
          `SELECT DISTINCT ch.id, ch.name, ch.gender, ch.birth_date,
                  ch.attention_reason, ch.attention_start_date, ch.attention_end_date, ch.attention_tags,
                  c.name AS class_name, c.grade_level, vb.venue_id
             FROM venue_bookings vb
             JOIN children ch ON ch.class_id = vb.class_id
             JOIN classes c ON c.id = ch.class_id
            WHERE vb.round_id = ?
              AND vb.status = 'confirmed'
              AND vb.venue_id IN (${bookedVenueIds.map(() => '?').join(', ')})
              AND ch.enabled = 1
              AND ch.needs_attention = 1
              AND (ch.attention_start_date IS NULL OR ch.attention_start_date <= CURDATE())
              AND (ch.attention_end_date IS NULL OR ch.attention_end_date >= CURDATE())
            ORDER BY vb.venue_id ASC,
                     CASE c.grade_level WHEN 'small' THEN 1 WHEN 'middle' THEN 2 WHEN 'large' THEN 3 ELSE 99 END,
                     c.name ASC,
                     ch.name ASC`,
          [activeRound.id, ...bookedVenueIds]
        );
      }
    }

    res.render('user-venues', {
      ...baseView,
      venues,
      backgrounds,
      activeRound,
      bookingMap,
      myGrade,
      myGradeLabel,
      classId: user.classId,
      attentionChildren,
      layoutBoardWidth,
      layoutBoardHeight
    });
  }));

  app.post('/user/venues/book', userOnly, asyncHandler(async (req, res) => {
    const user = req.session.user;
    const venueId = toNullableInt(req.body.venueId);
    const roundId = toNullableInt(req.body.roundId);

    if (!user.classId || !venueId || !roundId) {
      return res.redirect('/user/venues?message=' + encodeURIComponent('参数错误'));
    }

    const classRows = await dbQuery('SELECT grade_level FROM classes WHERE id = ? LIMIT 1', [user.classId]);
    if (!classRows.length) {
      return res.redirect('/user/venues?message=' + encodeURIComponent('班级不存在'));
    }
    const myGrade = classRows[0].grade_level;

    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [roundRows] = await connection.execute(
        `SELECT ${roundSelectSql()}
           FROM venue_round
          WHERE id = ?
          FOR UPDATE`,
        [roundId]
      );
      if (roundRows.length) {
        const nowText = chinaNowText();
        if (roundRows[0].status === 'pending' && nowText >= roundRows[0].open_time_text) {
          await connection.execute('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['open', roundId, 'pending']);
          roundRows[0].status = 'open';
        }
        if (roundRows[0].close_time_text && nowText >= roundRows[0].close_time_text && roundRows[0].status === 'open') {
          await connection.execute('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['closed', roundId, 'open']);
          roundRows[0].status = 'closed';
        }
      }
      if (!roundRows.length || roundRows[0].status !== 'open') {
        await connection.rollback();
        if (roundRows.length && roundRows[0].status === 'pending') {
          return res.redirect('/user/venues?message=' + encodeURIComponent('预约尚未开放，请等待倒计时结束'));
        }
        return res.redirect('/user/venues?message=' + encodeURIComponent('当前没有开放的预约'));
      }

      const nowText = chinaNowText();
      if (nowText < roundRows[0].open_time_text) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent('预约尚未开放'));
      }
      if (roundRows[0].close_time_text && nowText > roundRows[0].close_time_text) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent('预约已截止'));
      }

      const [venueRows] = await connection.execute('SELECT * FROM venues WHERE id = ? FOR UPDATE', [venueId]);
      if (!venueRows.length || !venueRows[0].enabled) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent('场地不存在'));
      }
      const venue = venueRows[0];

      const [duplicateRows] = await connection.execute(
        `SELECT id
           FROM venue_bookings
          WHERE round_id = ?
            AND class_id = ?
            AND status = 'confirmed'
          FOR UPDATE`,
        [roundId, user.classId]
      );
      if (duplicateRows.length) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent('您的班级本轮已预约了场地，请先取消才能更换'));
      }

      const capacityColumn = capField(myGrade);
      const maxCapacity = Number(venue[capacityColumn] || 0);
      const [countRows] = await connection.execute(
        `SELECT COUNT(*) AS cnt
           FROM venue_bookings
          WHERE round_id = ?
            AND venue_id = ?
            AND grade_pool = ?
            AND status = 'confirmed'`,
        [roundId, venueId, myGrade]
      );
      const booked = Number(countRows[0].cnt || 0);

      if (booked >= maxCapacity) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent(`该场地的${gradeLabel(myGrade)}名额已满`));
      }

      await connection.execute(
        `INSERT INTO venue_bookings (round_id, venue_id, class_id, user_id, grade_pool, status)
         VALUES (?, ?, ?, ?, ?, 'confirmed')`,
        [roundId, venueId, user.classId, user.id, myGrade]
      );

      await connection.commit();
      res.redirect('/user/venues?message=' + encodeURIComponent(`预约成功：${venue.name}`));
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.redirect('/user/venues?message=' + encodeURIComponent('您的班级本轮已有预约'));
      }
      console.error('Venue booking error:', error);
      res.redirect('/user/venues?message=' + encodeURIComponent('预约失败，请重试'));
    } finally {
      connection.release();
    }
  }));

  app.post('/user/venues/cancel', userOnly, asyncHandler(async (req, res) => {
    const user = req.session.user;
    const bookingId = toNullableInt(req.body.bookingId);
    if (!bookingId) {
      return res.redirect('/user/venues?message=' + encodeURIComponent('参数错误'));
    }

    await dbQuery(
      `UPDATE venue_bookings
          SET status = 'cancelled'
        WHERE id = ?
          AND class_id = ?
          AND status = 'confirmed'`,
      [bookingId, user.classId]
    );

    res.redirect('/user/venues?message=' + encodeURIComponent('已取消预约'));
  }));

  app.get('/api/venue-round/status', userOnly, asyncHandler(async (req, res) => {
    const rows = await dbQuery(`
      SELECT ${roundSelectSql()}
        FROM venue_round
       WHERE status IN ('pending', 'open')
       ORDER BY round_date ASC
       LIMIT 1
    `);

    if (!rows.length) {
      return res.json({ active: false });
    }

    const round = rows[0];
    const nowText = chinaNowText();

    if (round.status === 'pending' && nowText >= round.open_time_text) {
      await dbQuery('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['open', round.id, 'pending']);
      round.status = 'open';
    }

    if (round.close_time_text && nowText >= round.close_time_text && round.status === 'open') {
      await dbQuery('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['closed', round.id, 'open']);
      round.status = 'closed';
    }

    res.json({
      active: true,
      roundId: round.id,
      roundDate: round.round_date_text || round.round_date,
      openTime: round.open_time_text,
      closeTime: round.close_time_text,
      status: round.status,
      serverTime: Date.now()
    });
  }));
};
