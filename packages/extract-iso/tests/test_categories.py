from iso_bom.categories import BoltExtractor, GasketExtractor


def test_bolt_categories_exclude_support_u_bolts():
    bolt = BoltExtractor()
    assert bolt.matches("STUD-BOLT A193 GR B7 W/A194 GR 2H NUTS")
    assert bolt.matches("CAP SCREW HEX HEAD CR-MO")
    assert not bolt.matches('5UG, U-BOLT GUIDE FOR UNINSULATED LINES 4" PIPE')


def test_gasket_category():
    gasket = GasketExtractor()
    assert gasket.matches('GASKET 150# PTFE RING 1/8" THK')
    assert not gasket.matches("FLG WN 150# RF STL")

