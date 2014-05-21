var admin = {};

(function() {
	var canvas,
		menu;


	var windows = {
		opened: []
	};

	windows.init = function() {
		var opened = JSON.parse(localStorage.getItem('acp:windows:opened'));
		
		if (!opened || !opened.length) {
			windows.open('general/home');
		} else {
			for (var o in opened) {
				if (opened.hasOwnProperty(o)) {
					windows.open(opened[o]);
				}
			}
		}
	};


	windows.build = function(page) {
		templates.parse('window', {}, function(html) {
			$('#canvas').append($(html));
		});
	};

	windows.open = function(el) {
		if (!(el instanceof $)) {
			el = $('[data-page="' + el + '"]');
		}

		if (!el.length) {
			console.error('Page does not exist: ' + el);
			return false;
		}

		var page = el.attr('data-page'),
			arrIndex = windows.opened.indexOf(page);

		if (arrIndex === -1 || !el.hasClass('selected')) {
			if (arrIndex === -1) {
				windows.opened.push(page);	
			}
			
			$('#menu .item').removeClass('selected');
			el.addClass('selected active');
			el.parents('.category').addClass('active');

			windows.build(page);
		} else {
			windows.opened.splice(arrIndex, 1);
			el.removeClass('selected active');
			windows.open(windows.opened[windows.opened.length - 1]);
		}

		localStorage.setItem('acp:windows:opened', JSON.stringify(windows.opened));
	};


	function onConnect() {
		$('#profile').addClass('active').children('.avatar').attr('src', app.userpicture);
	}

	$(function() {
		canvas = canvas || $('#canvas');
		menu = menu || $('#menu');

		$('#menu .title').on('click', function() {
			$(this).parent().toggleClass('active');
		});

		$('#menu .item').on('click', function() {
			windows.open($(this));
		});

		templates.registerLoader(function(template, callback) {
			if (templates.cache[template]) {
				callback(templates.cache[template]);
			} else {
				$.ajax({
					url: RELATIVE_PATH + '/admin/templates/' + template + '.tpl' + (config['cache-buster'] ? '?v=' + config['cache-buster'] : ''),
					type: 'GET',
					success: function(data) {
						callback(data.toString());
					},
					error: function(error) {
						throw new Error("Unable to load template: " + template + " (" + error.statusText + ")");
					}
				});
			}
		});



		$(window).on('action:connected', onConnect);

		windows.init();
	});
}());