import { Scene } from 'phaser';

export class MapGenTest extends Scene
{
    camera: Phaser.Cameras.Scene2D.Camera;
    background: Phaser.GameObjects.Image;
    msg_text : Phaser.GameObjects.Text;

    constructor ()
    {
        super('MapGenTest');
    }

    create ()
    {
        this.camera = this.cameras.main;
        this.camera.setBackgroundColor(0x00ff00);

        const width = this.scale.width;
        const height = this.scale.height;
        const cellSize = 16;

        this.add.grid(
            width / 2,
            height / 2,
            width,
            height,
            cellSize,
            cellSize,
            0x000000,
            1,
            0xffffff,
            1
        );

        this.input.once('pointerdown', () => {
            this.scene.start('GameOver');
        });
    }
}