import io,json
from pathlib import Path
from unittest.mock import patch
import pytest
from PIL import Image,ImageChops,ImageDraw
import core.json_renderer as renderer
from core.image_processing import convert_image_block

BASE=Path(renderer.__file__).parent/'modes/builtin'

@pytest.mark.parametrize('language',['zh','en'])
@pytest.mark.parametrize('width,height,colors',[(768,552,4),(400,300,2),(296,128,4),(648,480,4)])
def test_photo_covers_entire_panel_without_status_or_footer(language,width,height,colors):
    source=Image.new('RGB',(width,height),'#c80000')
    draw=ImageDraw.Draw(source)
    draw.rectangle((0,0,width//2-1,height//2-1),fill='#e8b000')
    draw.rectangle((width//2,height//2,width-1,height-1),fill='black')
    buf=io.BytesIO();source.save(buf,format='PNG')
    definition=json.loads((BASE/('en/my_adaptive.json' if language=='en' else 'my_adaptive.json')).read_text())
    actual=renderer.render_json_mode(definition,{'image_url':'test.png','_prefetched_image_url':buf.getvalue()},date_str='TEST DATE',weather_str='TEST WEATHER',battery_pct=50,time_str='12:34',screen_w=width,screen_h=height,colors=colors,language=language)
    expected=convert_image_block(source,width,height,colors,fit='cover',photo_enhance=True)
    difference=ImageChops.difference(actual.convert('RGB'),expected.convert('RGB'))
    assert difference.getbbox() is None,'Photo differs from the edge-to-edge image: status/footer or margins remain'

def test_other_modes_keep_status_and_footer():
    definition=json.loads((BASE/'memo.json').read_text())
    with patch.object(renderer,'draw_status_bar',wraps=renderer.draw_status_bar) as status,patch.object(renderer,'draw_footer',wraps=renderer.draw_footer) as footer:
        renderer.render_json_mode(definition,{'memo_text':'test'},date_str='2026-10-19',weather_str='Clear',battery_pct=50,screen_w=768,screen_h=552,colors=4)
    status.assert_called_once()
    footer.assert_called_once()
